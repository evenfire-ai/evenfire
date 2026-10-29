import {
  type HTMLAttributes,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  CheckOutlined,
  CloseOutlined,
  DownloadOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOutlined,
  RightOutlined,
  ShareAltOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button as AntButton,
  Breadcrumb,
  Card,
  Empty,
  Flex,
  Input,
  Modal,
  Progress,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE,
  GFS_UPLOAD_NAME_RETRY_LIMIT,
  createGfsUploadNameReservationBook,
  gfsUploadNameRetryDecision,
  normalizeGfsResourceName,
} from '@clerum/gfs-interaction-policy'
import { isEditorGfsPermissions, planGfsInheritedRoleChange } from '@clerum/gfs-interaction-policy'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { GFS_DRIVE_MAIN, GFS_RESOURCE_DRAG_TYPE } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  GFS_UNAVAILABLE_LOCATION_MESSAGE,
  type GfsCrumb,
  type GfsDiscoveryFailure,
  useGfsBrowserController,
} from '@hooks/domain/useGfsBrowserController'
import { isEventFromNestedInteractive } from '@lib/clickableRowProps'
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
  parseRetryAfterSeconds,
} from '@lib/gfsGrantErrors'
import { isGfsPreviewFile, resolveGfsPreview } from '@lib/gfsPreview'
import { formatSharedFileSize } from '@lib/sharedFiles'
import { GfsGrantList } from '@/gfs/GfsGrantList'
import type { GfsAccessRole } from '@/gfs/GfsGrantList'
import type { GfsMergedAccessRow } from '@/gfs/GfsGrantList/types'
import { GfsInheritedAccessDialog } from '@/gfs/GfsInheritedAccessDialog'
import type { GfsInheritedAccessDialogRequest } from '@/gfs/GfsInheritedAccessDialog/types'
import {
  type GfsAgentSubjectOption,
  GfsDelegationPanel,
  type GfsDelegationSubjectOption,
  type GfsGrantListItem,
} from '@/gfs/delegation'
import type { GfsInheritedAccessSource, GfsInheritedCoverageState } from '@/gfs/delegation.types'
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
import { suggestNumberedMoveName } from '@/gfs/moveCommit'
import type { MoveCommitOutcome } from '@/gfs/moveCommit'
import { runGfsMoveCommit } from '@/gfs/moveCommitRunner'
import { GfsMoveConfirmDialog } from '@/gfs/moveConfirmDialog'
import { GfsMoveDialog } from '@/gfs/moveDialog'
import type { TeamDirectoryResult } from '../../../src/types'
import type { FilesPageProps, GfsDriveResource, MyAgentEntry } from './FilesPage.types'

function hasBit(affordances: { held?: string[] } | null, bit: string): boolean {
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
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}

function GfsInlineRename({
  value,
  busy = false,
  onChange,
  onCancel,
  onSubmit,
}: GfsInlineRenameProps) {
  return (
    <form
      aria-label="Rename resource"
      onClick={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Input
        aria-label="New name"
        autoFocus
        size="small"
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
        onFocus={event => event.currentTarget.select()}
      />
      <Flex align="center" gap="small">
        <AntButton
          aria-label="Save name"
          title="Save name"
          disabled={!value.trim()}
          loading={busy}
          htmlType="submit"
          icon={<CheckOutlined aria-hidden="true" />}
          size="small"
        />
        <AntButton
          aria-label="Cancel rename"
          title="Cancel rename"
          disabled={busy}
          htmlType="button"
          icon={<CloseOutlined aria-hidden="true" />}
          size="small"
          onClick={onCancel}
        />
      </Flex>
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
  pendingGfsUri,
  onPendingGfsUriHandled,
  remoteGfsChangeEpoch,
  onLocationChange,
  onOpenPreview,
}: FilesPageProps) {
  const [createFolderName, setCreateFolderName] = useState('')
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [createFolderError, setCreateFolderError] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<GfsActionTarget | null>(null)
  const [moveTarget, setMoveTarget] = useState<GfsActionTarget | null>(null)
  const [renameTarget, setRenameTarget] = useState<GfsActionTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [openLinkOpen, setOpenLinkOpen] = useState(false)
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
    destination: { resourceId: string; name: string }
    allowNumberedRename: boolean
    suggestedName?: string
  } | null>(null)
  const draggingResourceRef = useRef<GfsDriveResource | null>(null)
  const draggingSourceRef = useRef<GfsDragSource | null>(null)
  const movingResourceRef = useRef<string | null>(null)
  const hoveredFolderRef = useRef<string | null>(null)
  const hoverOwnerRef = useRef<GfsDragSource | null>(null)
  const dragSessionRef = useRef(0)
  const manageReturnCrumbsRef = useRef<GfsCrumb[] | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const uploadNameReservationsRef = useRef(createGfsUploadNameReservationBook())
  const createFolderTitleId = useId()
  const createFolderDescriptionId = useId()
  const createFolderInputId = useId()
  const queryClient = useQueryClient()
  const ctrl = useGfsBrowserController({ grantsListEnabled: manageOpen })
  const {
    current,
    crumbs,
    sessionScope,
    accessibleResources,
    items,
    affordances,
    affordancesError,
    loadingAffordances,
    loadingAccessible,
    loading,
    accessibleError,
    accessibleNotice,
    error,
    openError,
    resolving,
    refreshAffordances,
  } = ctrl

  // Cross-surface drag coordinator (null outside the provider — e.g. unit
  // tests — where the local per-surface ref drives same-surface drags).
  const dragSession = useGfsDragSession()
  const adjudication = useGfsDragAdjudication({
    scope: sessionScope,
    drive: GFS_DRIVE_MAIN,
    resolve: useCallback((uri: string) => window.clerum.gfs.resolve(uri), []),
    // A drag probe that answers 401 is a session failure, not a per-item
    // refusal: the drop is refused AND the session revoked.
    handleAuthorityFailure: useCallback(
      (message: string) => ctrl.handleAuthorityFailure(message, 'operation'),
      [ctrl]
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

  const liveDragScope = ctrl.accessState === 'revoked' ? null : (sessionScope ?? 'anonymous')
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
    if (!sessionScope) return
    // A running folder-zip walk holds the same per-actor read budget this
    // prefetch spends; a burst here is one more 429 away from killing the
    // job, so the warmer stays idle until the walk finishes (L9).
    if (zipJobRef.current) return
    const folders = items
      .filter(item => item.kind === 'directory')
      .map(folder => ({
        folder,
        key: desktopQueryKeys.gfsChildren(sessionScope, folder.resourceId, 'main'),
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
  }, [items, queryClient, sessionScope])

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
    const returnCrumbs = manageReturnCrumbsRef.current
    manageReturnCrumbsRef.current = null
    if (returnCrumbs) ctrl.restoreCrumbs(returnCrumbs)
  }, [ctrl.restoreCrumbs])
  const openCreateFolder = useCallback(() => {
    setCreateFolderName('')
    setCreateFolderError(null)
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
  const accessRevoked = ctrl.accessState === 'revoked'
  // R4 spec §1: on an authority failure every local surface that could show
  // or act on stale GFS data must close — Manage, Move, rename, delete,
  // open-link, and the inline create-folder form. File previews now live in
  // their own tab (spec 18 §3.B.5), which fails closed independently via its own
  // authority controller, so there is nothing preview-related to reset here.
  useEffect(() => {
    if (!accessRevoked) return
    manageReturnCrumbsRef.current = null
    setManageOpen(false)
    setMoveTarget(null)
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
    (error: unknown): boolean =>
      ctrl.handleAuthorityFailure(
        error instanceof Error ? error.message : String(error),
        'operation'
      ),
    [ctrl]
  )
  const canWriteCurrent = !accessRevoked && hasBit(affordances, 'write')
  const canDeleteCurrent = !accessRevoked && hasBit(affordances, 'delete')
  // The Manage modal lists ACL rows, and view-ACL = manage-ACL server-side —
  // a caller without the bit gets the API's 403, so the entry must not show.
  const canManageCurrent = !accessRevoked && hasBit(affordances, 'manage_acl')
  const currentIsFolder = current?.kind === 'directory'
  const currentIsFile = current?.kind === 'file'
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
    if (!affordances) {
      return `Upload permissions for ${current.name} are still loading. Try again in a moment.`
    }
    if (!canWriteCurrent) {
      return `You can’t upload to ${current.name} because you don’t have write permission for this folder.`
    }
    return null
  }, [affordances, affordancesError, canWriteCurrent, current, currentIsFolder])

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
    resource: Pick<GfsDriveResource, 'bytes' | 'gfsUri' | 'name' | 'version'>
  ): boolean => {
    const preview = resolveGfsPreview(resource)
    if (!preview || !onOpenPreview) return false
    onOpenPreview(preview)
    return true
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
      setMoveTarget(null)
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
  const handleGrant = async (subjectKeys: string[], bits: string[], inherit: boolean) => {
    try {
      await ctrl.grant(subjectKeys, bits, inherit)
    } catch (grantError) {
      if (failClosedOnAuthorizationError(grantError)) return
      throw grantError
    }
    pushToast?.(
      `Access granted to ${subjectKeys.length} ${subjectKeys.length === 1 ? 'subject' : 'subjects'}`,
      'success'
    )
    // The grant PUT returns no ids — list-after-write is the revoke-id source.
    await ctrl.refreshGrants()
  }

  const handleRevokeGrant = async (grantId: string, label: string) => {
    try {
      await ctrl.revokeGrant(grantId)
      pushToast?.(`Access revoked for ${label}`, 'success')
    } catch (revokeError) {
      if (failClosedOnAuthorizationError(revokeError)) return
      pushToast?.(describeGfsGrantError(revokeError).message, 'error')
    }
  }

  const handleRevokeShare = async (shareId: string, label: string) => {
    try {
      await ctrl.revokeShare(shareId)
      pushToast?.(`Shared access revoked for ${label}`, 'success')
    } catch (revokeError) {
      if (failClosedOnAuthorizationError(revokeError)) return
      pushToast?.(describeGfsGrantError(revokeError).message, 'error')
    }
  }

  const handleAccessRoleChange = async (
    item: GfsGrantListItem,
    label: string,
    role: GfsAccessRole
  ) => {
    const bits = rolePermissionRequest(item.subject.type, role).filter(bit =>
      affordances?.grantableBits.includes(bit)
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
        folderAffordances = await window.clerum.gfs.affordances(source.resourceId, GFS_DRIVE_MAIN)
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
            GFS_DRIVE_MAIN,
            source.grantInherit === true
          )
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

  const handleCopyLink = async (uri: string) => {
    try {
      await navigator.clipboard.writeText(uri)
      pushToast?.('EvenDrive link copied', 'success')
    } catch (clipboardError) {
      pushToast?.(
        clipboardError instanceof Error
          ? clipboardError.message
          : 'Could not copy the EvenDrive link',
        'error'
      )
    }
  }

  const handleOpenGfsLink = async (uri: string) => {
    const returnCrumbs = [...crumbs]
    const opened = await ctrl.openUri(uri)
    if (opened === false) return false
    if (typeof opened === 'object' && opened.kind === 'file') {
      const previewOpened = openFilePreview(opened)
      ctrl.restoreCrumbs(returnCrumbs)
      if (!previewOpened) await handleDownload(opened.gfsUri, opened.name)
    }
    return true
  }

  // A non-null seed rebuilds the breadcrumb stack asynchronously (openUri is a
  // network round-trip). Until it lands, `current` is still the virtual root, and
  // reporting that transient `null` back up would clobber the owning tab's
  // persisted path to null — losing the location if the user switches tabs
  // mid-load (mini-spec 06 §3). Arm on a non-null seed so location reports are
  // withheld until the seed is consumed; a null seed (root tab) never arms.
  const seedPendingRef = useRef(false)

  /**
   * Open a link handed over from the app level (a plugin's `gfs://` click that
   * this page handles better than the overlay). Cleared immediately so a
   * re-render cannot reopen it, and failures surface the browser's own error.
   */
  useEffect(() => {
    if (!pendingGfsUri) return
    // Re-arm on every non-null seed so a deep-link onto an already-mounted page
    // suppresses the pre-open location the same way the initial mount does.
    seedPendingRef.current = true
    onPendingGfsUriHandled?.()
    void handleOpenGfsLink(pendingGfsUri)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGfsUri])

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

  const handleCreateFolder = async () => {
    const requestedName = createFolderName.trim()
    if (!requestedName) return
    setCreateFolderError(null)
    try {
      const name = await normalizeGfsResourceName(requestedName)
      await ctrl.createFolder(name)
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
    occupiedNames = new Set(items.map(item => item.name))
  ) => {
    if (!file || !parentResourceId) return
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
    const cached = queryClient.getQueryData<{ pages?: Array<{ items?: GfsDriveResource[] }> }>(
      desktopQueryKeys.gfsChildren(sessionScope ?? 'anonymous', destinationId, GFS_DRIVE_MAIN)
    )
    return new Set((cached?.pages ?? []).flatMap(page => page.items?.map(item => item.name) ?? []))
  }

  /** Shared move dispatch (rev-2 §5) used by the drag path, the folder
   * confirmation and the Move dialog — one service, one code path.
   *
   * `isCurrent` is the gesture-ownership predicate: the drag path passes the
   * ownership check it already runs at admission, so the commit re-validates
   * it at the dispatch boundary too (the explicit Move dialog owns no gesture
   * and passes none). */
  const runMoveCommit = async (
    source: GfsDragSource,
    destination: { resourceId: string; name: string },
    allowNumberedRename: boolean,
    isCurrent?: () => boolean
  ): Promise<MoveCommitOutcome> => {
    movingResourceRef.current = source.resourceId
    setMovingResourceId(source.resourceId)
    try {
      return await runGfsMoveCommit(
        {
          moveResource: (resourceId, destinationId, ifMatch, newName, oldParentId) =>
            ctrl.moveResource(resourceId, destinationId, ifMatch, newName, oldParentId),
          handleAuthorityFailure: message => ctrl.handleAuthorityFailure(message, 'operation'),
          convergeCommittedMove: (input, receipt) => ctrl.convergeCommittedMove(input, receipt),
          ...(pushToast ? { pushToast } : {}),
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
    try {
      const decision = await adjudication.adjudicateDrop(source, {
        resourceId: destination.resourceId,
        name: destination.name,
        kind: destination.kind,
        ancestorIds: rowTargetAncestorIds(),
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
        // The ONE folder confirmation (rev-2 §1): impact + naming policy in a
        // single dialog; dispatch happens on explicit Move.
        const occupied = cachedDestinationNames(destination.resourceId)
        const suggested = suggestNumberedMoveName(source.name, occupied)
        setPendingFolderMove({
          source,
          gestureGeneration: dragGeneration,
          sessionGeneration,
          destination: { resourceId: destination.resourceId, name: destination.name },
          allowNumberedRename: decision.allowNumberedRename,
          ...(suggested !== undefined ? { suggestedName: suggested } : {}),
        })
        return
      }
      await runMoveCommit(
        source,
        { resourceId: destination.resourceId, name: destination.name },
        decision.allowNumberedRename,
        () => ownsDrop(source, dragGeneration, sessionGeneration)
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
        await handleUploadFile(file, destinationResourceId, occupiedNames)
      }
    } finally {
      setDroppedUploadCount(0)
    }
  }

  const handleReplaceCurrentFile = async (file: File | null | undefined) => {
    if (!file || !current) return
    try {
      assertGfsFileUploadSize(file.size)
      const filePath = window.clerum.gfs.getPathForFile(file)
      if (!filePath) throw new Error('Could not resolve the selected local file')
      await ctrl.replaceFileFromPath(current.resourceId, filePath, current.version)
      pushToast?.(`Replaced ${current.name}`, 'success')
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
    const requestedName = renameName.trim()
    if (!requestedName) return
    try {
      const name = await normalizeGfsResourceName(requestedName)
      if (name === current.name) {
        setRenameOpen(false)
        return
      }
      await ctrl.renameResource(current.resourceId, name, current.version)
      setRenameOpen(false)
      pushToast?.(`Renamed to ${name}`, 'success')
    } catch (renameError) {
      if (failClosedOnAuthorizationError(renameError)) return
      pushToast?.(renameError instanceof Error ? renameError.message : String(renameError), 'error')
    }
  }

  const handleDeleteCurrent = async () => {
    if (!current) return
    try {
      await ctrl.deleteResource(current.resourceId, current.version)
      setDeleteOpen(false)
      closeManage()
      pushToast?.(`Deleted ${current.name}`, 'success')
    } catch (deleteError) {
      if (failClosedOnAuthorizationError(deleteError)) return
      pushToast?.(deleteError instanceof Error ? deleteError.message : String(deleteError), 'error')
    }
  }

  const handleDeleteResource = async (resource: GfsActionTarget) => {
    try {
      await ctrl.deleteResource(resource.resourceId, resource.version)
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

  /** Delete gate for list rows. Shared-with-me rows carry their permission
   * bits directly; child rows use their own server-computed affordances. */
  const rowCanDelete = (resource: GfsDriveResource): boolean => {
    if (currentIsFolder) return hasBit(rowAffordancesFor(resource), 'delete')
    return Boolean(resource.permissions?.includes('delete'))
  }

  /** Rename needs `write` on the resource itself. */
  const rowCanRename = (resource: GfsDriveResource): boolean => {
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

  /** Move-dialog commit through the shared dispatch: success toasts and
   *  closes; failure throws the presented verdict so the dialog shows it
   *  in place; an authority rejection fails the session closed instead. */
  const handleMoveTarget = async (destinationId: string, destinationName: string) => {
    if (!moveTarget) return
    const target = moveTarget
    const source: GfsDragSource = {
      resourceId: target.resourceId,
      gfsUri: `gfs://${GFS_DRIVE_MAIN}/${target.resourceId.replace(/-/g, '').toLowerCase()}`,
      drive: GFS_DRIVE_MAIN,
      kind: target.kind,
      name: target.name,
      ...(Number.isSafeInteger(target.version) ? { version: target.version } : {}),
      parentKnown: target.parentResourceId != null,
      parentResourceId: target.parentResourceId ?? null,
      knownAncestorIds: [],
      origin: 'files',
      scope: sessionScope ?? 'anonymous',
      generation: dragSessionRef.current,
    }
    // Files and explicit dialog moves may use numbered names when the source
    // resource is writable (rev-2 §5).
    const allowNumberedRename = await adjudication.probeSourceWrite(target.resourceId)
    const outcome = await runMoveCommit(
      source,
      { resourceId: destinationId, name: destinationName },
      allowNumberedRename
    )
    if (outcome.status === 'session-lost' || outcome.status === 'gesture-lost') {
      setMoveTarget(null)
      return
    }
    if (outcome.status !== 'committed' && outcome.status !== 'no-op') {
      throw new Error(outcome.message)
    }
    setMoveTarget(null)
  }

  const requestMoveCurrent = () => {
    if (current) setMoveTarget(current)
  }

  /** Page-level rename works inline for any row or the current resource; the
   *  manage dialog keeps its own inline title-edit flow. Errors toast (stale
   *  version → retry), matching the manage-dialog rename behavior. */
  const handleRenameTarget = async () => {
    if (!renameTarget) return
    const target = renameTarget
    const requestedName = renameDraft.trim()
    if (!requestedName) return
    try {
      const name = await normalizeGfsResourceName(requestedName)
      if (name === target.name) {
        setRenameTarget(null)
        return
      }
      await ctrl.renameResource(target.resourceId, name, target.version)
      setRenameTarget(null)
      pushToast?.(`Renamed to ${name}`, 'success')
    } catch (renameError) {
      if (failClosedOnAuthorizationError(renameError)) return
      pushToast?.(renameError instanceof Error ? renameError.message : String(renameError), 'error')
    }
  }

  const openRenameTarget = (target: GfsActionTarget) => {
    setRenameTarget(target)
    setRenameDraft(target.name)
  }

  /** Adapt the open folder crumb for the row-action handlers so the active
   *  folder's menu (the one beside the breadcrumb) runs on the same shape a
   *  parent-view row does. */
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

  /** Single construction path for a FOLDER's ⋯ menu. The parent-view row menu
   *  and the active folder's breadcrumb menu both build their props here, so
   *  their option lists cannot drift apart; only the gates (permission source)
   *  and the open-navigation action differ per surface. */
  const folderMenuPropsFor = (
    folder: GfsDriveResource,
    gates: { canManage: boolean; canRename: boolean; canDelete: boolean },
    actions: { onOpen?: () => void; onOpenChange?: (open: boolean) => void } = {}
  ) => ({
    resourceName: folder.name,
    onManage: gates.canManage ? () => openManage(folder) : undefined,
    onCopyLink: () => void handleCopyLink(folder.gfsUri),
    onOpen: actions.onOpen,
    onOpenGfsLink: () => setOpenLinkOpen(true),
    onOpenChange: actions.onOpenChange,
    onRename: gates.canRename ? () => openRenameTarget(folder) : undefined,
    onMove: () => setMoveTarget(folder),
    onDelete: gates.canDelete ? () => setDeleteTarget(folder) : undefined,
    onDownloadZip:
      folder.readable === false
        ? undefined
        : () => {
            void handleFolderZipDownload(folder)
          },
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
  // authorityPending keeps the loading state up: cached rows must not render
  // (and must not be mistaken for an empty folder) until discovery re-proves
  // the session (R4 spec §1).
  //
  // A settled discovery error is not a pending load, though — the same
  // principle the controller already applies to `loadingAccessible`. The flag
  // itself stays true, because a 429 or a 404 does not re-prove the session and
  // the controller must go on withholding every cached surface; what changes is
  // only that the page stops calling that a load in progress. Without this a
  // 404 from an older server leaves "Loading files…" spinning forever
  // underneath the notice that says discovery is unavailable, and a link opened
  // while discovery is down never reveals the file it resolved.
  const visibleLoading =
    (ctrl.authorityPending && !ctrl.discoveryFailure) ||
    (currentIsFolder ? loading : !current ? loadingAccessible : false)
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
    if (resource.resourceId !== current?.resourceId) {
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

  const openResource = (resource: GfsDriveResource) => {
    // The children listing marks rows the session cannot read (e.g. a folder
    // grant without inheritance). Surfacing that here keeps the click honest
    // instead of failing later with a bare download 403. Rows without the
    // flag (older servers) keep today's behavior.
    if (resource.readable === false) {
      pushToast?.(`You do not have read access to ${resource.name || resource.drive}`, 'error')
      return
    }
    if (resource.kind === 'directory') {
      if (currentIsFolder) ctrl.openChild(resource)
      else ctrl.openResource(resource)
      return
    }
    if (openFilePreview(resource)) return
    void handleDownload(resource.gfsUri, resource.name)
  }

  const currentIsBeingRenamed = renameTarget?.resourceId === current?.resourceId
  const currentIsInBreadcrumbs = Boolean(
    current && crumbs.some(crumb => crumb.resourceId === current.resourceId)
  )

  const resourceColumns: TableColumnsType<GfsDriveResource> = [
    {
      key: 'kind',
      title: '',
      width: 48,
      render: (_value, resource) => (
        <span data-testid="gfs-resource-icon" aria-hidden="true">
          {resource.kind === 'directory' ? (
            <FolderOutlined />
          ) : (
            <GfsFileIcon name={resource.name} />
          )}
        </span>
      ),
    },
    {
      key: 'name',
      title: 'Name',
      render: (_value, resource) => (
        <Flex
          vertical
          align={renameTarget?.resourceId === resource.resourceId ? undefined : 'flex-start'}
          gap="small"
        >
          {renameTarget?.resourceId === resource.resourceId ? (
            <GfsInlineRename
              onCancel={() => setRenameTarget(null)}
              onChange={setRenameDraft}
              onSubmit={() => void handleRenameTarget()}
              value={renameDraft}
              busy={ctrl.mutating}
            />
          ) : (
            <AntButton htmlType="button" type="link" onClick={() => openResource(resource)}>
              {resource.name || resource.drive}
            </AntButton>
          )}
          {resource.readable === false ? <Tag>No access</Tag> : null}
        </Flex>
      ),
    },
    {
      key: 'size',
      title: 'Size',
      align: 'right',
      render: (_value, resource) => (
        <Typography.Text type="secondary" data-testid="gfs-resource-size">
          {formatSharedFileSize(resource.bytes)}
        </Typography.Text>
      ),
    },
    {
      key: 'actions',
      title: 'Actions',
      align: 'right',
      render: (_value, resource) => (
        <Flex align="center" gap="small" justify="flex-end" wrap>
          {rowCanManage(resource) ? (
            <AntButton
              htmlType="button"
              type="text"
              size="small"
              icon={<ShareAltOutlined aria-hidden="true" />}
              aria-label={`Share ${resource.name || resource.drive}`}
              onClick={() => openManage(resource)}
            />
          ) : null}
          {resource.kind === 'file' ? (
            <AntButton
              htmlType="button"
              type="text"
              size="small"
              icon={<DownloadOutlined aria-hidden="true" />}
              aria-label={`Download ${resource.name}`}
              onClick={() => void handleDownload(resource.gfsUri, resource.name)}
              disabled={resource.readable === false}
            />
          ) : null}
          {rowCanRename(resource) ? (
            <AntButton
              htmlType="button"
              type="text"
              size="small"
              icon={<EditOutlined aria-hidden="true" />}
              aria-label={`Rename ${resource.name || resource.drive}`}
              onClick={() => openRenameTarget(resource)}
            />
          ) : null}
          {resource.kind === 'directory' ? (
            <GfsResourceMenu
              {...folderMenuPropsFor(
                resource,
                {
                  canManage: rowCanManage(resource),
                  canRename: rowCanRename(resource),
                  canDelete: rowCanDelete(resource),
                },
                {
                  onOpen: () => openResource(resource),
                  onOpenChange: open =>
                    ctrl.setRowAffordancesResourceId(open ? resource.resourceId : null),
                }
              )}
            />
          ) : (
            <GfsResourceMenu
              resourceName={resource.name}
              onManage={rowCanManage(resource) ? () => openManage(resource) : undefined}
              onCopyLink={() => void handleCopyLink(resource.gfsUri)}
              onDelete={rowCanDelete(resource) ? () => setDeleteTarget(resource) : undefined}
              onOpenChange={open =>
                ctrl.setRowAffordancesResourceId(open ? resource.resourceId : null)
              }
              onRename={rowCanRename(resource) ? () => openRenameTarget(resource) : undefined}
              onMove={() => setMoveTarget(resource)}
              onPreview={
                resource.readable !== false && isGfsPreviewFile(resource.name)
                  ? () => void openFilePreview(resource)
                  : undefined
              }
              onDownload={
                resource.readable !== false && resource.kind === 'file'
                  ? () => void handleDownload(resource.gfsUri, resource.name)
                  : undefined
              }
            />
          )}
        </Flex>
      ),
    },
  ]

  return (
    <section aria-label="Files">
      {/* The drop verdict is painted on the target row; this live region is
          its spoken form, so a screen reader learns whether the folder under
          the pointer accepts the move (RP-026). */}
      <p aria-live="polite" className="visually-hidden">
        {dropVerdictAnnouncement}
      </p>
      <Flex vertical gap="large">
        <Flex vertical gap="small">
          <Typography.Title level={2}>Files</Typography.Title>
          <Typography.Text type="secondary">
            Browse and manage everything shared with you in one place.
          </Typography.Text>
        </Flex>

        <Card
          data-gfs-browser="true"
          role="region"
          aria-label="EvenDrive browser"
          styles={{ root: { background: 'transparent' } }}
          aria-busy={driveBusy}
          onDragEnter={handleGfsDragEnter}
          onDragLeave={handleGfsDragLeave}
          onDragOver={handleGfsDragOver}
          onDrop={event => void handleGfsDrop(event)}
        >
          <Flex vertical gap="middle">
            <Flex align="center" gap="middle" justify="space-between" wrap>
              <Flex data-testid="gfs-title-row" align="center" gap="small" wrap>
                <nav aria-label="File location">
                  <Breadcrumb
                    separator={<RightOutlined aria-hidden="true" />}
                    styles={{
                      item: { display: 'flex', alignItems: 'center' },
                      separator: { display: 'flex', alignItems: 'center' },
                    }}
                    items={[
                      {
                        key: 'root',
                        title: (
                          <AntButton
                            htmlType="button"
                            size="small"
                            type="link"
                            disabled={!current}
                            onClick={() => {
                              manageReturnCrumbsRef.current = null
                              setManageOpen(false)
                              ctrl.reset()
                            }}
                          >
                            Shared with me
                          </AntButton>
                        ),
                      },
                      ...crumbs.map((crumb, index) => ({
                        key: crumb.resourceId,
                        title:
                          renameTarget?.resourceId === crumb.resourceId ? (
                            <GfsInlineRename
                              onCancel={() => setRenameTarget(null)}
                              onChange={setRenameDraft}
                              onSubmit={() => void handleRenameTarget()}
                              value={renameDraft}
                              busy={ctrl.mutating}
                            />
                          ) : (
                            <AntButton
                              htmlType="button"
                              size="small"
                              type="link"
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
                              data-drop-reason={gfsDropVerdictReason(
                                dropStatesById[crumb.resourceId]
                              )}
                              onClick={
                                index === crumbs.length - 1
                                  ? undefined
                                  : () => ctrl.goToCrumb(index)
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
                            >
                              {crumb.name}
                            </AntButton>
                          ),
                      })),
                    ]}
                  />
                </nav>
                {!current ? (
                  <GfsResourceMenu
                    resourceName="Shared with me"
                    onOpenGfsLink={() => setOpenLinkOpen(true)}
                  />
                ) : null}
                {current && !currentIsFile && currentIsBeingRenamed && !currentIsInBreadcrumbs ? (
                  <GfsInlineRename
                    onCancel={() => setRenameTarget(null)}
                    onChange={setRenameDraft}
                    onSubmit={() => void handleRenameTarget()}
                    value={renameDraft}
                    busy={ctrl.mutating}
                  />
                ) : null}
                {current && !currentIsFile && !currentIsBeingRenamed ? (
                  <GfsResourceMenu
                    {...folderMenuPropsFor(crumbAsResource(current), {
                      canManage: canManageCurrent,
                      canRename: canWriteCurrent,
                      canDelete: canDeleteCurrent,
                    })}
                  />
                ) : null}
              </Flex>
              {currentIsFolder && canWriteCurrent ? (
                <Flex data-testid="gfs-header-actions" align="center" gap="small" wrap>
                  <AntButton
                    htmlType="button"
                    disabled={ctrl.mutating}
                    icon={<FolderAddOutlined aria-hidden="true" />}
                    onClick={openCreateFolder}
                    size="small"
                    type="primary"
                  >
                    New folder
                  </AntButton>
                  <AntButton
                    htmlType="button"
                    disabled={ctrl.mutating}
                    icon={<UploadOutlined aria-hidden="true" />}
                    onClick={() => uploadInputRef.current?.click()}
                    size="small"
                  >
                    Upload file
                  </AntButton>
                  <input
                    aria-label="Upload file"
                    className="visually-hidden"
                    ref={uploadInputRef}
                    type="file"
                    onChange={event => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ''
                      void handleUploadFile(file)
                    }}
                  />
                </Flex>
              ) : null}
            </Flex>
          </Flex>

          {dragActive || droppedUploadCount > 0 ? (
            <Alert
              className="da-gfs-drop-overlay"
              role="status"
              showIcon
              type="info"
              title={
                droppedUploadCount > 0
                  ? `Uploading ${droppedUploadCount} ${droppedUploadCount === 1 ? 'file' : 'files'}…`
                  : droppedUploadRestriction ||
                    `Drop files to upload to ${current?.name || 'this folder'}`
              }
            />
          ) : null}

          {dropSessionLost ? (
            // Persistent (A11): the refusal outlives the dead gesture and the
            // revoked surface below — it is not a one-shot toast.
            <Alert role="alert" showIcon type="error" title={GFS_DROP_SESSION_LOST_MESSAGE} />
          ) : null}
          {zipJob ? (
            <Alert
              role="status"
              showIcon
              type="info"
              data-testid="gfs-zip-progress"
              title={
                <Flex align="center" gap="middle" justify="space-between" wrap>
                  <Flex vertical>
                    <Typography.Text>
                      {zipJob.progress.phase === 'listing'
                        ? `Preparing ${zipJob.folderName}.zip — reading folder contents…`
                        : zipJob.progress.phase === 'downloading'
                          ? `Preparing ${zipJob.folderName}.zip — downloading ${zipJob.progress.filesAdded} of ${zipJob.progress.filesFound} ${zipJob.progress.filesFound === 1 ? 'file' : 'files'}…`
                          : `Preparing ${zipJob.folderName}.zip — assembling archive…`}
                    </Typography.Text>
                    {zipJob.progress.phase === 'downloading' ? (
                      <Progress
                        percent={
                          zipJob.progress.filesFound > 0
                            ? Math.round(
                                (zipJob.progress.filesAdded / zipJob.progress.filesFound) * 100
                              )
                            : 0
                        }
                        size="small"
                        status="active"
                      />
                    ) : (
                      <Spin size="small" />
                    )}
                  </Flex>
                  <AntButton
                    htmlType="button"
                    size="small"
                    aria-label="Stop preparing zip"
                    onClick={() => zipAbortRef.current?.abort()}
                  >
                    Stop
                  </AntButton>
                </Flex>
              }
            />
          ) : null}

          {accessibleNotice ? (
            <Alert role="status" showIcon type="info" title={accessibleNotice} />
          ) : null}
          {unavailableLocation ? (
            <Alert role="alert" showIcon type="error" title={GFS_UNAVAILABLE_LOCATION_MESSAGE} />
          ) : null}
          {visibleError && !accessRevoked && !blockingFailure ? (
            // Presented, not raw. The banner is the non-blocking half of the
            // same read-plane failure the card shows, so it must not be the one
            // surface left leaking `Error invoking remote method '…'` at the
            // user — which is what it did for every failure the card declines
            // to take over, a rate-limited `Load more` among them.
            <Alert
              role="alert"
              showIcon
              type="error"
              title={describeGfsReadError(visibleError).message}
            />
          ) : null}

          {accessRevoked ? (
            <>
              {/* The revoked surface owns the session-ended sentence (A11): it
                  outlives any gesture's ownership, so a drag whose probe died
                  stays explained even after the revocation invalidated it. */}
              <Alert role="alert" showIcon type="error" title={GFS_DROP_SESSION_LOST_MESSAGE} />
              <Empty
                description={
                  <Flex vertical gap="small">
                    <Typography.Title level={5}>File access is not authorized</Typography.Title>
                    <Typography.Text type="secondary">
                      Your current Desktop session cannot access this location. Sign in again or
                      contact an administrator.
                    </Typography.Text>
                  </Flex>
                }
              />
              <Flex justify="center">
                <AntButton htmlType="button" onClick={() => ctrl.retryAccess()} size="small">
                  Retry file access
                </AntButton>
              </Flex>
            </>
          ) : blockingFailure ? (
            <GfsReadFailureCard
              failure={blockingFailure.failure}
              onRetry={() => {
                void blockingFailure.retry()
              }}
            />
          ) : visibleLoading ? (
            <Flex
              role="status"
              aria-label="Loading files"
              aria-live="polite"
              align="center"
              gap="small"
            >
              <Spin aria-hidden="true" size="small" />
              <Typography.Text>Loading files…</Typography.Text>
            </Flex>
          ) : currentIsFile ? (
            <Flex align="start" gap="middle">
              <span aria-hidden="true">
                <GfsFileIcon name={current.name} />
              </span>
              <Flex vertical gap="small">
                <Flex align="center" gap="small">
                  {currentIsBeingRenamed ? (
                    <GfsInlineRename
                      onCancel={() => setRenameTarget(null)}
                      onChange={setRenameDraft}
                      onSubmit={() => void handleRenameTarget()}
                      value={renameDraft}
                      busy={ctrl.mutating}
                    />
                  ) : (
                    <>
                      <Typography.Title level={3}>{current.name}</Typography.Title>
                      <GfsResourceMenu
                        resourceName={current.name}
                        onManage={
                          canManageCurrent
                            ? () => {
                                manageReturnCrumbsRef.current = crumbs.slice(0, -1)
                                setCreateFolderOpen(false)
                                setRenameOpen(false)
                                setDeleteOpen(false)
                                setManageOpen(true)
                              }
                            : undefined
                        }
                        onCopyLink={() => void handleCopyLink(current.gfsUri)}
                        onDelete={canDeleteCurrent ? () => setDeleteTarget(current) : undefined}
                        onReplace={
                          canWriteCurrent ? file => void handleReplaceCurrentFile(file) : undefined
                        }
                        onRename={canWriteCurrent ? () => openRenameTarget(current) : undefined}
                        onMove={requestMoveCurrent}
                        onPreview={
                          currentPreviewAvailable ? () => void openFilePreview(current) : undefined
                        }
                        onDownload={() => void handleDownload(current.gfsUri, current.name)}
                      />
                    </>
                  )}
                </Flex>
                <Typography.Text type="secondary">
                  {currentPreviewAvailable
                    ? 'Preview this file again or use the menu to manage and download it.'
                    : 'Use the menu to manage, download, or copy this file’s EvenDrive link.'}
                </Typography.Text>
              </Flex>
            </Flex>
          ) : visibleResources.length === 0 ? (
            // `unsupported` earns its own copy because the other two assert
            // something this branch cannot know. An older server that has no
            // listing endpoint never told us the library was empty — it told us
            // it cannot answer — and "No shared files yet" reports the absence
            // of an answer as an answer. No Retry either: the endpoint will not
            // appear because the user pressed a button. The banner above already
            // points at opening a link, so this states the one thing it does
            // not: the list is missing, the files may not be.
            <Empty
              description={
                <Flex vertical gap="small">
                  <Typography.Title level={5}>
                    {rootListingUnsupported
                      ? 'Files cannot be listed here'
                      : currentIsFolder
                        ? 'This folder is empty'
                        : 'No shared files yet'}
                  </Typography.Title>
                  <Typography.Text type="secondary">
                    {rootListingUnsupported
                      ? 'This server cannot list shared resources, so Evenfire has no way to tell what you have access to. That does not mean you have none.'
                      : currentIsFolder
                        ? 'Files and folders added here will appear in this list.'
                        : 'Resources shared directly with you or your teams will appear here.'}
                  </Typography.Text>
                </Flex>
              }
            />
          ) : (
            <Table<GfsDriveResource>
              data-testid="gfs-resource-table"
              className="gfs-resource-table"
              columns={resourceColumns}
              dataSource={visibleResources}
              rowKey="resourceId"
              rowClassName="gfs-resource-row"
              size="small"
              pagination={false}
              onRow={resource => {
                const isDragging =
                  draggingResourceId === resource.resourceId ||
                  movingResourceId === resource.resourceId
                const isDropTarget = dragOverFolderId === resource.resourceId
                const dropState =
                  resource.kind === 'directory' ? dropStatesById[resource.resourceId] : undefined
                const dropReason = gfsDropVerdictReason(dropState)
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

                const rowProps = {
                  draggable: canDragResource,
                  title:
                    dropReasonTooltip ??
                    (canDragResource
                      ? 'Drag ' + resource.name + ' into a folder to move it'
                      : undefined),
                  role: 'button',
                  tabIndex: 0,
                  'aria-label':
                    resource.readable === false
                      ? (resource.name || resource.drive) + ' (no read access)'
                      : 'Open ' + (resource.name || resource.drive),
                  'data-testid': 'gfs-resource-row-' + resource.resourceId,
                  'data-resource-kind': resource.kind,
                  'data-dragging': isDragging ? 'true' : undefined,
                  'data-drop-target': isDropTarget ? 'true' : undefined,
                  'data-drop-state': dropState?.state,
                  'data-drop-reason': dropReason,
                  onClick: (event: ReactMouseEvent<HTMLTableRowElement>) => {
                    if (isEventFromNestedInteractive(event)) return
                    openResource(resource)
                  },
                  onKeyDown: (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    if (isEventFromNestedInteractive(event)) return
                    event.preventDefault()
                    openResource(resource)
                  },
                  onDragStart: canDragResource
                    ? (event: ReactDragEvent<HTMLTableRowElement>) =>
                        handleResourceDragStart(event, resource)
                    : undefined,
                  onDragEnd: canDragResource ? handleResourceDragEnd : undefined,
                  onDragEnter:
                    resource.kind === 'directory'
                      ? (event: ReactDragEvent<HTMLTableRowElement>) =>
                          handleFolderDragOver(event, resource)
                      : undefined,
                  onDragOver:
                    resource.kind === 'directory'
                      ? (event: ReactDragEvent<HTMLTableRowElement>) =>
                          handleFolderDragOver(event, resource)
                      : undefined,
                  onDragLeave: resource.kind === 'directory' ? handleFolderDragLeave : undefined,
                  onDrop:
                    resource.kind === 'directory'
                      ? (event: ReactDragEvent<HTMLTableRowElement>) =>
                          void handleFolderDrop(event, {
                            resourceId: resource.resourceId,
                            name: resource.name,
                            kind: 'directory',
                          })
                      : undefined,
                } as unknown as HTMLAttributes<HTMLTableRowElement>
                return rowProps
              }}
            />
          )}
          {hasMoreVisible ? (
            <Flex justify="center">
              <AntButton
                htmlType="button"
                loading={loadingMoreVisible}
                onClick={currentIsFolder ? ctrl.loadMore : ctrl.loadMoreAccessible}
                size="small"
              >
                Load more
              </AntButton>
            </Flex>
          ) : null}
        </Card>
      </Flex>

      <Modal
        open={openLinkOpen}
        onCancel={() => setOpenLinkOpen(false)}
        closable={{ 'aria-label': 'Close EvenDrive link dialog' }}
        destroyOnHidden
        footer={null}
        keyboard={false}
        title="Open EvenDrive link"
      >
        <Flex vertical gap="middle">
          <Typography.Text type="secondary">
            Paste an EvenDrive link to jump directly to a shared resource.
          </Typography.Text>
          <GfsFilePicker
            onOpen={handleOpenGfsLink}
            onOpened={() => setOpenLinkOpen(false)}
            busy={resolving}
            error={openError}
          />
        </Flex>
      </Modal>

      <Modal
        open={manageOpen && Boolean(current)}
        onCancel={closeManage}
        aria-label={
          current ? `Share ${currentIsFolder ? 'folder' : 'file'} ${current.name}` : undefined
        }
        closable={false}
        destroyOnHidden
        footer={null}
        keyboard={false}
        title={
          <Flex align="center" gap="middle" justify="space-between">
            <Flex align="center" gap="small">
              <span aria-hidden="true">
                {currentIsFolder ? (
                  <FolderOutlined />
                ) : current ? (
                  <GfsFileIcon name={current.name} />
                ) : null}
              </span>
              {renameOpen ? (
                <form
                  aria-label="Rename resource"
                  onSubmit={event => {
                    event.preventDefault()
                    void handleRenameCurrent()
                  }}
                >
                  <Input
                    aria-label="New name"
                    autoFocus
                    size="small"
                    value={renameName}
                    onChange={event => setRenameName(event.currentTarget.value)}
                  />
                  <AntButton htmlType="submit" loading={ctrl.mutating} size="small" type="primary">
                    Save
                  </AntButton>
                  <AntButton
                    htmlType="button"
                    onClick={() => setRenameOpen(false)}
                    size="small"
                    type="text"
                  >
                    Cancel
                  </AntButton>
                </form>
              ) : (
                <Typography.Title
                  aria-label={`Share ${currentIsFolder ? 'folder' : 'file'} ${current?.name ?? ''}`}
                  level={4}
                >
                  Share “{current?.name ?? ''}”
                </Typography.Title>
              )}
            </Flex>
            <AntButton
              autoFocus
              aria-label="Close share dialog"
              title="Close share dialog"
              htmlType="button"
              icon={<CloseOutlined aria-hidden="true" />}
              onClick={closeManage}
              size="small"
              type="text"
            />
          </Flex>
        }
      >
        {current ? (
          <Flex vertical gap="large">
            {canDeleteCurrent && deleteOpen ? (
              <div className="da-gfs-inline-form" role="alertdialog" aria-label="Delete resource">
                <span className="da-gfs-inline-form__copy">Delete {current.name}?</span>
                <AntButton
                  htmlType="button"
                  danger
                  loading={ctrl.mutating}
                  onClick={() => void handleDeleteCurrent()}
                  size="small"
                >
                  Delete
                </AntButton>
                <AntButton
                  htmlType="button"
                  onClick={() => setDeleteOpen(false)}
                  size="small"
                  type="text"
                >
                  Cancel
                </AntButton>
              </div>
            ) : null}

            <section className="da-gfs-manage-section da-gfs-manage-section--access">
              <div className="da-gfs-manage-section__header">
                <div>
                  <h4>Add people, teams, agents, or workflows</h4>
                </div>
              </div>
              {loadingAffordances ? (
                <p className="muted">Refreshing permissions…</p>
              ) : affordancesError ? (
                <Alert role="alert" showIcon type="error" title={affordancesError} />
              ) : affordances ? (
                <>
                  <GfsDelegationPanel
                    affordances={affordances}
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
                </>
              ) : (
                <p className="muted">Loading permissions…</p>
              )}
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
                  items={ctrl.grants}
                  loading={ctrl.loadingGrants || ctrl.loadingShares || ctrl.loadingInheritedAccess}
                  // FILES AND FOLDERS merge inherited rows (the reported
                  // folder bug); the dialog itself only opens with a target.
                  mergeInherited
                  onChangeInheritedRole={handleInheritedRoleChange}
                  onChangeRole={affordances?.canDelegate ? handleAccessRoleChange : undefined}
                  onRemoveInherited={handleInheritedRemove}
                  onRevoke={(item, label) => void handleRevokeGrant(item.id, label)}
                  onRevokeShare={(item, label) => void handleRevokeShare(item.id, label)}
                  revoking={ctrl.revoking}
                  revokingShare={ctrl.revokingShare}
                  shareError={sharesError}
                  shares={ctrl.shares}
                  subjects={delegationSubjects}
                  updatingRole={updatingAccessRole}
                />
              </section>
            ) : null}
          </Flex>
        ) : null}
      </Modal>

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

      <Modal
        open={createFolderOpen && currentIsFolder && canWriteCurrent}
        onCancel={() => {
          if (!ctrl.mutating) closeCreateFolder()
        }}
        aria-describedby={createFolderDescriptionId}
        closable={false}
        destroyOnHidden
        footer={null}
        keyboard={false}
        mask={{ closable: !ctrl.mutating }}
        title={
          <Typography.Title id={createFolderTitleId} level={4}>
            New folder
          </Typography.Title>
        }
      >
        <Flex vertical gap="middle">
          <Typography.Text id={createFolderDescriptionId} type="secondary">
            Create a new folder in {current?.name ?? ''}.
          </Typography.Text>
          <form
            aria-label="Create folder"
            onSubmit={event => {
              event.preventDefault()
              void handleCreateFolder()
            }}
          >
            <Flex vertical gap="middle">
              <label htmlFor={createFolderInputId}>
                <span>Folder name</span>
                <Input
                  aria-label="Folder name"
                  autoComplete="off"
                  autoFocus
                  disabled={ctrl.mutating}
                  id={createFolderInputId}
                  placeholder="e.g. research-notes"
                  size="small"
                  spellCheck={false}
                  value={createFolderName}
                  onChange={event => setCreateFolderName(event.currentTarget.value)}
                />
              </label>
              {createFolderError ? (
                <Alert role="alert" showIcon type="error" title={createFolderError} />
              ) : null}
              <Flex justify="end" gap="small">
                <AntButton
                  htmlType="button"
                  disabled={ctrl.mutating}
                  onClick={closeCreateFolder}
                  size="small"
                  type="text"
                >
                  Cancel
                </AntButton>
                <AntButton
                  htmlType="submit"
                  disabled={!createFolderName.trim()}
                  loading={ctrl.mutating}
                  size="small"
                  type="primary"
                >
                  Create folder
                </AntButton>
              </Flex>
            </Flex>
          </form>
        </Flex>
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onOk={() => {
          if (deleteTarget) void handleDeleteResource(deleteTarget)
        }}
        cancelButtonProps={{ autoFocus: true }}
        confirmLoading={ctrl.mutating}
        destroyOnHidden
        okText="Delete"
        okType="danger"
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : 'Delete resource'}
      >
        {deleteTarget ? (
          <Typography.Text>
            {deleteTarget.kind === 'directory'
              ? 'The folder and everything inside it will be deleted for everyone with access.'
              : 'The file will be deleted for everyone with access.'}
          </Typography.Text>
        ) : null}
      </Modal>

      {moveTarget ? (
        <GfsMoveDialog
          busy={ctrl.mutating}
          initialCrumbs={
            moveTarget.resourceId === current?.resourceId ? crumbs.slice(0, -1) : crumbs
          }
          onClose={() => setMoveTarget(null)}
          onMove={handleMoveTarget}
          onAuthorityFailure={message => ctrl.handleAuthorityFailure(message, 'operation')}
          sessionScope={sessionScope}
          target={moveTarget}
        />
      ) : null}

      {pendingFolderMove ? (
        <GfsMoveConfirmDialog
          busy={movingResourceId === pendingFolderMove.source.resourceId}
          request={{
            sourceName: pendingFolderMove.source.name,
            destinationName: pendingFolderMove.destination.name,
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
              void runMoveCommit(pending.source, pending.destination, allowNumberedRename, () =>
                ownsDrop(pending.source, pending.gestureGeneration, pending.sessionGeneration)
              )
            }
          }}
        />
      ) : null}
    </section>
  )
}
