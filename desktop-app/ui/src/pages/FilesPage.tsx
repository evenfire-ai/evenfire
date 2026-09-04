import {
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, EmptyState, IconButton, StatusBanner, TextInput } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsImagePreview } from '@components/GfsImagePreview'
import { GfsMarkdownPreview } from '@components/GfsMarkdownPreview'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { GfsVideoPreview } from '@components/GfsVideoPreview'
import {
  IconAttachFile,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconConnectors,
  IconContexts,
  IconDownload,
  IconEdit,
  IconShare,
  IconUpload,
} from '@components/SidebarNav/icons'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { type GfsCrumb, useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { isEventFromNestedInteractive } from '@lib/clickableRowProps'
import { assertGfsFileUploadSize } from '@lib/gfsFileUpload'
import { describeGfsGrantError } from '@lib/gfsGrantErrors'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import { isGfsMarkdownPreviewFile } from '@lib/gfsMarkdownPreview'
import { gfsVideoPreviewMimeType } from '@lib/gfsVideoPreview'
import { formatSharedFileSize } from '@lib/sharedFiles'
import { GfsGrantList } from '@/gfs/GfsGrantList'
import {
  type GfsAgentSubjectOption,
  GfsDelegationPanel,
  type GfsDelegationSubjectOption,
} from '@/gfs/delegation'
import { GfsFilePicker } from '@/gfs/filePicker'
import { GfsMoveDialog } from '@/gfs/moveDialog'
import { nextAvailableGfsResourceName, normalizeGfsResourceName } from '@/gfs/resourceName'
import type { TeamDirectoryResult } from '../../../src/types'
import type {
  FilesPageProps,
  GfsDriveResource,
  GfsPreviewResource,
  MyAgentEntry,
} from './FilesPage.types'

function hasBit(affordances: { held?: string[] } | null, bit: string): boolean {
  return Boolean(affordances?.held?.includes(bit))
}

function hasDraggedFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes('Files')
}

const GFS_RESOURCE_DRAG_TYPE = 'application/x-evenfire-gfs-resource'

function hasDraggedGfsResource(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)
}

type FolderDropAccessResult = { allowed: boolean; error?: unknown }

function isGfsPreviewFile(fileName: string): boolean {
  return (
    gfsImagePreviewMimeType(fileName) !== null ||
    isGfsMarkdownPreviewFile(fileName) ||
    gfsVideoPreviewMimeType(fileName) !== null
  )
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

function isGfsNameConflict(error: unknown): boolean {
  const details =
    error && typeof error === 'object'
      ? (error as {
          status?: unknown
          bodyText?: unknown
          message?: unknown
          response?: { status?: unknown }
        })
      : null
  const status = details?.status ?? details?.response?.status
  if (status === 409 || status === '409') return true

  const messageParts = details
    ? [details.message, details.bodyText].filter(value => value != null).map(String)
    : []
  const message =
    error instanceof Error
      ? error.message
      : messageParts.length > 0
        ? messageParts.join(' ')
        : String(error)
  return (
    /\b409\b[\s\S]*\bconflict\b/i.test(message) ||
    /\bconflict\b[\s\S]*\b409\b/i.test(message) ||
    /\b(?:already exists|duplicate|name[_ ]?conflict|resource[_ ]?exists)\b/i.test(message)
  )
}

const GFS_UPLOAD_NAME_RETRY_LIMIT = 100

/** Any row/header action target — a listing row (GfsDriveResource) or the
 *  current breadcrumb (GfsCrumb); both carry the identity fields the delete /
 *  rename / move calls need (kind also powers dialog titles + the move cycle
 *  guard). */
type GfsActionTarget = Pick<GfsDriveResource, 'resourceId' | 'name' | 'version'> & {
  kind: 'file' | 'directory'
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

export function FilesPage({ pushToast, pendingGfsUri, onPendingGfsUriHandled }: FilesPageProps) {
  const [createFolderName, setCreateFolderName] = useState('')
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<GfsActionTarget | null>(null)
  const [moveTarget, setMoveTarget] = useState<GfsActionTarget | null>(null)
  const [renameTarget, setRenameTarget] = useState<GfsActionTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [openLinkOpen, setOpenLinkOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [filePreview, setFilePreview] = useState<GfsPreviewResource | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [droppedUploadCount, setDroppedUploadCount] = useState(0)
  const [draggingResourceId, setDraggingResourceId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [movingResourceId, setMovingResourceId] = useState<string | null>(null)
  const draggingResourceRef = useRef<GfsDriveResource | null>(null)
  const movingResourceRef = useRef<string | null>(null)
  const hoveredFolderRef = useRef<string | null>(null)
  const folderDropAccessRef = useRef(new Map<string, FolderDropAccessResult>())
  const folderDropChecksRef = useRef(new Map<string, Promise<FolderDropAccessResult>>())
  const dragSessionRef = useRef(0)
  const manageReturnCrumbsRef = useRef<GfsCrumb[] | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const uploadNameReservationsRef = useRef(new Map<string, Set<string>>())
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

  // Warm the cache for every directory row visible in the current view
  // so clicking into a folder is instant. Re-runs whenever the listing
  // changes (folder navigation, refresh, …) and silently no-ops if a
  // folder was already prefetched. TanStack Query's staleTime:Infinity
  // (set in lib/queryClient.ts) keeps the cached data hot until the user
  // actually navigates there.
  useEffect(() => {
    if (!sessionScope) return
    const folders = items.filter(item => item.kind === 'directory')
    if (folders.length === 0) return
    void Promise.all(
      folders.map(folder =>
        queryClient
          .fetchInfiniteQuery({
            queryKey: desktopQueryKeys.gfsChildren(sessionScope, folder.resourceId, 'main'),
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
  const accessRevoked = ctrl.accessState === 'revoked'
  // R4 spec §1: on an authority failure every local surface that could show
  // or act on stale GFS data must close — preview bytes, Manage, Move, rename,
  // delete, open-link, and the inline create-folder form.
  useEffect(() => {
    if (!accessRevoked) return
    manageReturnCrumbsRef.current = null
    setFilePreview(null)
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

  // Preview byte-fetches are imperative downloads: an authority failure must
  // reach the central fail-closed boundary, not just the in-dialog error.
  const handlePreviewDownloadError = useCallback(
    (error: unknown) => {
      failClosedOnAuthorizationError(error)
    },
    [failClosedOnAuthorizationError]
  )

  const openFilePreview = (
    resource: Pick<GfsDriveResource, 'bytes' | 'gfsUri' | 'name'>
  ): boolean => {
    const mimeType = gfsImagePreviewMimeType(resource.name)
    if (mimeType) {
      setFilePreview({
        gfsUri: resource.gfsUri,
        kind: 'image',
        mimeType,
        name: resource.name,
        bytes: resource.bytes,
      })
      return true
    }
    if (isGfsMarkdownPreviewFile(resource.name)) {
      setFilePreview({
        bytes: resource.bytes,
        gfsUri: resource.gfsUri,
        kind: 'markdown',
        name: resource.name,
      })
      return true
    }
    const videoMimeType = gfsVideoPreviewMimeType(resource.name)
    if (videoMimeType) {
      setFilePreview({
        bytes: resource.bytes,
        gfsUri: resource.gfsUri,
        kind: 'video',
        mimeType: videoMimeType,
        name: resource.name,
      })
      return true
    }
    return false
  }

  useEffect(() => {
    if (!manageOpen && !openLinkOpen && !moveTarget && !renameTarget) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      closeManage()
      setOpenLinkOpen(false)
      setMoveTarget(null)
      setRenameTarget(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeManage, manageOpen, openLinkOpen, moveTarget, renameTarget])

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

  const handleDownload = async (uri: string, name: string) => {
    try {
      const { bytes } = await window.clerum.gfs.download(uri)
      const url = URL.createObjectURL(new Blob([bytes]))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      pushToast?.(`Downloaded ${name}`, 'success')
    } catch (downloadError) {
      if (failClosedOnAuthorizationError(downloadError)) return
      pushToast?.(
        downloadError instanceof Error ? downloadError.message : String(downloadError),
        'error'
      )
    }
  }

  const handleCopyLink = async (uri: string) => {
    try {
      await navigator.clipboard.writeText(uri)
      pushToast?.('GFS link copied', 'success')
    } catch (clipboardError) {
      pushToast?.(
        clipboardError instanceof Error ? clipboardError.message : 'Could not copy the GFS link',
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

  /**
   * Open a link handed over from the app level (a plugin's `gfs://` click that
   * this page handles better than the overlay). Cleared immediately so a
   * re-render cannot reopen it, and failures surface the browser's own error.
   */
  useEffect(() => {
    if (!pendingGfsUri) return
    onPendingGfsUriHandled?.()
    void handleOpenGfsLink(pendingGfsUri)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGfsUri])

  const handleCreateFolder = async () => {
    const requestedName = createFolderName.trim()
    if (!requestedName) return
    try {
      const name = await normalizeGfsResourceName(requestedName)
      await ctrl.createFolder(name)
      setCreateFolderName('')
      setCreateFolderOpen(false)
      pushToast?.(`Folder ${name} created`, 'success')
    } catch (createError) {
      if (failClosedOnAuthorizationError(createError)) return
      pushToast?.(createError instanceof Error ? createError.message : String(createError), 'error')
    }
  }

  const handleUploadFile = async (
    file: File | null | undefined,
    parentResourceId = current?.resourceId,
    occupiedNames = new Set(items.map(item => item.name))
  ) => {
    if (!file || !parentResourceId) return
    const attemptedNames = new Set<string>()
    try {
      assertGfsFileUploadSize(file.size)
      const normalizedName = await normalizeGfsResourceName(file.name)
      const filePath = window.clerum.gfs.getPathForFile(file)
      if (!filePath) throw new Error('Could not resolve the selected local file')

      for (let attempt = 0; attempt < GFS_UPLOAD_NAME_RETRY_LIMIT; attempt += 1) {
        const reservations =
          uploadNameReservationsRef.current.get(parentResourceId) ?? new Set<string>()
        uploadNameReservationsRef.current.set(parentResourceId, reservations)
        const name = nextAvailableGfsResourceName(normalizedName, [
          ...occupiedNames,
          ...reservations,
        ])
        reservations.add(name)
        attemptedNames.add(name)

        try {
          await ctrl.createFileFromPath(parentResourceId, name, filePath)
          occupiedNames.add(name)
          pushToast?.(`Uploaded ${name}`, 'success')
          return
        } catch (uploadError) {
          if (!isGfsNameConflict(uploadError)) throw uploadError
          occupiedNames.add(name)
        }
      }

      throw new Error('Could not create a unique GFS resource name.')
    } catch (uploadError) {
      if (failClosedOnAuthorizationError(uploadError)) return
      pushToast?.(uploadError instanceof Error ? uploadError.message : String(uploadError), 'error')
    } finally {
      const reservations = uploadNameReservationsRef.current.get(parentResourceId)
      for (const name of attemptedNames) reservations?.delete(name)
      if (reservations?.size === 0) uploadNameReservationsRef.current.delete(parentResourceId)
    }
  }

  const clearResourceDrag = () => {
    dragSessionRef.current += 1
    draggingResourceRef.current = null
    hoveredFolderRef.current = null
    folderDropAccessRef.current.clear()
    folderDropChecksRef.current.clear()
    setDraggingResourceId(null)
    setDragOverFolderId(null)
  }

  const resolveFolderDropAccess = (folder: GfsDriveResource): Promise<FolderDropAccessResult> => {
    const cached = folderDropAccessRef.current.get(folder.resourceId)
    if (cached) return Promise.resolve(cached)
    const pending = folderDropChecksRef.current.get(folder.resourceId)
    if (pending) return pending

    const dragSession = dragSessionRef.current
    const check = Promise.resolve()
      .then(() => window.clerum.gfs.affordances(folder.resourceId, 'main'))
      .then(result => ({ allowed: result.held.includes('write') }))
      .catch((permissionError: unknown) => {
        const failedClosed = failClosedOnAuthorizationError(permissionError)
        return { allowed: false, error: failedClosed ? undefined : permissionError }
      })
      .then(result => {
        if (dragSession === dragSessionRef.current) {
          folderDropAccessRef.current.set(folder.resourceId, result)
          if (result.allowed && hoveredFolderRef.current === folder.resourceId) {
            setDragOverFolderId(folder.resourceId)
          }
        }
        return result
      })
      .finally(() => {
        if (dragSession === dragSessionRef.current) {
          folderDropChecksRef.current.delete(folder.resourceId)
        }
      })

    folderDropChecksRef.current.set(folder.resourceId, check)
    return check
  }

  const handleResourceDragStart = (
    event: ReactDragEvent<HTMLElement>,
    resource: GfsDriveResource
  ) => {
    if (resource.kind === 'directory' || movingResourceRef.current) {
      event.preventDefault()
      return
    }
    dragSessionRef.current += 1
    folderDropAccessRef.current.clear()
    folderDropChecksRef.current.clear()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(GFS_RESOURCE_DRAG_TYPE, resource.resourceId)
    event.dataTransfer.setData('text/plain', resource.name)
    draggingResourceRef.current = resource
    setDraggingResourceId(resource.resourceId)
  }

  const handleResourceDragEnd = () => {
    clearResourceDrag()
  }

  const handleFolderDragOver = (event: ReactDragEvent<HTMLElement>, folder: GfsDriveResource) => {
    if (!hasDraggedGfsResource(event)) return
    const source = draggingResourceRef.current
    if (!source || folder.kind !== 'directory' || source.resourceId === folder.resourceId) return

    event.preventDefault()
    event.stopPropagation()
    hoveredFolderRef.current = folder.resourceId
    const access = folderDropAccessRef.current.get(folder.resourceId)
    if (access?.allowed) {
      event.dataTransfer.dropEffect = 'move'
      setDragOverFolderId(folder.resourceId)
      return
    }

    event.dataTransfer.dropEffect = 'none'
    setDragOverFolderId(null)
    if (!access) void resolveFolderDropAccess(folder)
  }

  const handleFolderDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedGfsResource(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      hoveredFolderRef.current = null
      setDragOverFolderId(null)
    }
  }

  const handleFolderDrop = async (
    event: ReactDragEvent<HTMLElement>,
    destination: GfsDriveResource
  ) => {
    if (!hasDraggedGfsResource(event)) return
    event.preventDefault()
    event.stopPropagation()
    hoveredFolderRef.current = null
    setDragOverFolderId(null)
    const source = draggingResourceRef.current
    if (!source || destination.kind !== 'directory' || movingResourceRef.current) return

    try {
      const access = await resolveFolderDropAccess(destination)
      if (!access.allowed) {
        const message = access.error
          ? access.error instanceof Error
            ? access.error.message
            : String(access.error)
          : `You can’t move files to ${destination.name} because you don’t have write permission for this folder.`
        pushToast?.(message, 'error')
        return
      }

      movingResourceRef.current = source.resourceId
      setMovingResourceId(source.resourceId)
      try {
        await ctrl.moveResource(source.resourceId, destination.resourceId, source.version)
        pushToast?.(`Moved ${source.name} to ${destination.name}`, 'success')
      } catch (moveError) {
        if (failClosedOnAuthorizationError(moveError)) return
        pushToast?.(moveError instanceof Error ? moveError.message : String(moveError), 'error')
      } finally {
        movingResourceRef.current = null
        setMovingResourceId(null)
      }
    } finally {
      clearResourceDrag()
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
   * Delete gate for list rows. Root "shared with me" rows already carry their
   * permission bits; folder children don't, so their gate resolves lazily from
   * the affordances of the one row whose ⋯ menu is open.
   */
  const rowCanDelete = (resource: GfsDriveResource): boolean => {
    if (currentIsFolder) {
      return (
        ctrl.rowAffordancesResourceId === resource.resourceId &&
        Boolean(ctrl.rowAffordances?.held.includes('delete'))
      )
    }
    return Boolean(resource.permissions?.includes('delete'))
  }

  /** Rename gate: same lazy resolution as rowCanDelete, but on the write bit
   *  (rename needs `write` on the resource itself). */
  const rowCanRename = (resource: GfsDriveResource): boolean => {
    if (currentIsFolder) {
      return (
        ctrl.rowAffordancesResourceId === resource.resourceId &&
        Boolean(ctrl.rowAffordances?.held.includes('write'))
      )
    }
    return Boolean(resource.permissions?.includes('write'))
  }

  /** Manage gate: the ACL modal needs `manage_acl` (view-ACL = manage-ACL
   *  server-side). Same lazy row resolution as delete/rename — a read-only
   *  row must not offer a Manage entry that would only 403 on open. */
  const rowCanManage = (resource: GfsDriveResource): boolean => {
    if (currentIsFolder) {
      return (
        ctrl.rowAffordancesResourceId === resource.resourceId &&
        Boolean(ctrl.rowAffordances?.held.includes('manage_acl'))
      )
    }
    return Boolean(resource.permissions?.includes('manage_acl'))
  }

  /** Move commits bubble their failure back to the dialog (in-place banner);
   *  success toasts and closes it. An authority rejection instead fails the
   *  session closed and closes the dialog — the revoked state takes over.
   *  ifMatch pins the resource version. */
  const handleMoveTarget = async (destinationId: string, destinationName: string) => {
    if (!moveTarget) return
    const target = moveTarget
    try {
      await ctrl.moveResource(target.resourceId, destinationId, target.version)
    } catch (moveError) {
      if (failClosedOnAuthorizationError(moveError)) {
        setMoveTarget(null)
        return
      }
      throw moveError
    }
    setMoveTarget(null)
    pushToast?.(`Moved ${target.name} to ${destinationName}`, 'success')
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
  const visibleLoading =
    ctrl.authorityPending || (currentIsFolder ? loading : !current ? loadingAccessible : false)
  const visibleError = currentIsFolder ? error : !current ? accessibleError : null
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

  return (
    <section className="page da-gfs-page">
      <div className="page-header">
        <h2>Files</h2>
        <p className="muted">Browse and manage everything shared with you in one place.</p>
      </div>

      <div className="page-layout da-gfs-layout">
        <section
          className="page-card da-gfs-drive"
          aria-label="Global File System browser"
          aria-busy={visibleLoading || droppedUploadCount > 0}
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
                    manageReturnCrumbsRef.current = null
                    setManageOpen(false)
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
                        className="da-gfs-drive__breadcrumb"
                        color="neutral"
                        disabled={index === crumbs.length - 1}
                        onClick={() => ctrl.goToCrumb(index)}
                        variant="text"
                      >
                        {crumb.name}
                      </Button>
                    )}
                  </span>
                ))}
              </nav>
              {!current ? (
                <GfsResourceMenu
                  resourceName="Shared with me"
                  onOpenGfsLink={() => setOpenLinkOpen(true)}
                />
              ) : null}
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
                  resourceName={current.name}
                  onManage={
                    canManageCurrent
                      ? () => {
                          setCreateFolderOpen(false)
                          setRenameOpen(false)
                          setDeleteOpen(false)
                          setManageOpen(true)
                        }
                      : undefined
                  }
                  onCopyLink={() => void handleCopyLink(current.gfsUri)}
                  onDelete={canDeleteCurrent ? () => setDeleteTarget(current) : undefined}
                  onOpenGfsLink={() => setOpenLinkOpen(true)}
                  onRename={canWriteCurrent ? () => openRenameTarget(current) : undefined}
                  onMove={requestMoveCurrent}
                />
              ) : null}
            </div>
            {currentIsFolder && canWriteCurrent ? (
              <div className="da-gfs-drive__header-actions">
                <Button
                  disabled={ctrl.mutating}
                  onClick={() => {
                    setCreateFolderName('')
                    setCreateFolderOpen(true)
                    setRenameOpen(false)
                    setDeleteOpen(false)
                    setManageOpen(true)
                  }}
                  size="sm"
                >
                  <IconContexts width={16} height={16} />
                  New folder
                </Button>
                <Button
                  color="neutral"
                  disabled={ctrl.mutating}
                  onClick={() => uploadInputRef.current?.click()}
                  size="sm"
                  variant="outline"
                >
                  <IconUpload width={16} height={16} />
                  Upload file
                </Button>
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
              </div>
            ) : null}
          </div>

          {dragActive || droppedUploadCount > 0 ? (
            <div className="composer-drop-overlay da-gfs-drop-overlay" role="status">
              {droppedUploadCount > 0
                ? `Uploading ${droppedUploadCount} ${droppedUploadCount === 1 ? 'file' : 'files'}…`
                : droppedUploadRestriction ||
                  `Drop files to upload to ${current?.name || 'this folder'}`}
            </div>
          ) : null}

          {accessibleNotice ? <StatusBanner tone="info" text={accessibleNotice} /> : null}
          {visibleError && !accessRevoked ? (
            <StatusBanner tone="error" text={visibleError} />
          ) : null}

          {accessRevoked ? (
            <>
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
                        onRename={canWriteCurrent ? () => openRenameTarget(current) : undefined}
                        onMove={requestMoveCurrent}
                        onPreview={
                          currentPreviewAvailable ? () => void openFilePreview(current) : undefined
                        }
                        onDownload={() => void handleDownload(current.gfsUri, current.name)}
                      />
                    </>
                  )}
                </div>
                <p className="muted">
                  {currentPreviewAvailable
                    ? 'Preview this file again or use the menu to manage and download it.'
                    : 'Use the menu to manage, download, or copy this file’s GFS link.'}
                </p>
              </div>
            </div>
          ) : visibleResources.length === 0 ? (
            <EmptyState
              title={currentIsFolder ? 'This folder is empty' : 'No shared files yet'}
              body={
                currentIsFolder
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
                  const isDragging =
                    draggingResourceId === resource.resourceId ||
                    movingResourceId === resource.resourceId
                  const isDropTarget = dragOverFolderId === resource.resourceId
                  const canDragResource =
                    resource.kind === 'file' &&
                    resource.readable !== false &&
                    movingResourceId === null &&
                    !ctrl.mutating
                  return (
                    <div
                      className="da-grid__row da-grid__row--clickable da-grid__row--compact"
                      key={resource.resourceId}
                      draggable={canDragResource}
                      title={
                        canDragResource
                          ? `Drag ${resource.name} into a folder to move it`
                          : undefined
                      }
                      data-dragging={isDragging ? 'true' : undefined}
                      data-drop-target={isDropTarget ? 'true' : undefined}
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
                          ? event => void handleFolderDrop(event, resource)
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
                        <GfsResourceMenu
                          resourceName={resource.name}
                          onManage={rowCanManage(resource) ? () => openManage(resource) : undefined}
                          onCopyLink={() => void handleCopyLink(resource.gfsUri)}
                          onDelete={
                            rowCanDelete(resource) ? () => setDeleteTarget(resource) : undefined
                          }
                          onOpen={
                            resource.kind === 'directory' ? () => openResource(resource) : undefined
                          }
                          onOpenChange={open =>
                            ctrl.setRowAffordancesResourceId(open ? resource.resourceId : null)
                          }
                          onRename={
                            rowCanRename(resource) ? () => openRenameTarget(resource) : undefined
                          }
                          onMove={() => setMoveTarget(resource)}
                          onPreview={
                            isGfsPreviewFile(resource.name)
                              ? () => void openFilePreview(resource)
                              : undefined
                          }
                          onDownload={
                            resource.kind === 'file'
                              ? () => void handleDownload(resource.gfsUri, resource.name)
                              : undefined
                          }
                        />
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
                <IconConnectors />
              </span>
              <span className="da-gfs-link-dialog__heading">
                <span className="da-gfs-eyebrow">Direct access</span>
                <h3 id="gfs-link-dialog-title">Open GFS link</h3>
                <span className="muted">
                  Paste a GFS URI to jump directly to a shared resource.
                </span>
              </span>
              <IconButton
                label="Close GFS link dialog"
                onClick={() => setOpenLinkOpen(false)}
                size="sm"
                variant="ghost"
              >
                <IconClose />
              </IconButton>
            </header>
            <div className="da-gfs-link-dialog__body">
              <GfsFilePicker
                onOpen={handleOpenGfsLink}
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
            aria-label={`Manage ${currentIsFolder ? 'folder' : 'file'} ${current.name}`}
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
                  <span className="da-gfs-manage-dialog__title-row">
                    <h3>{current.name}</h3>
                    <GfsResourceMenu
                      resourceName={current.name}
                      onCopyLink={() => void handleCopyLink(current.gfsUri)}
                      onCreateFolder={
                        currentIsFolder && canWriteCurrent
                          ? () => {
                              setCreateFolderName('')
                              setCreateFolderOpen(true)
                              setDeleteOpen(false)
                            }
                          : undefined
                      }
                      onDelete={
                        canDeleteCurrent
                          ? () => {
                              setDeleteOpen(true)
                              setCreateFolderOpen(false)
                            }
                          : undefined
                      }
                      onMove={requestMoveCurrent}
                      onDownload={
                        currentIsFile
                          ? () => void handleDownload(current.gfsUri, current.name)
                          : undefined
                      }
                      onPreview={
                        currentIsFile && currentPreviewAvailable
                          ? () => void openFilePreview(current)
                          : undefined
                      }
                      onRename={
                        canWriteCurrent
                          ? () => {
                              setRenameName(current.name)
                              setRenameOpen(true)
                              setCreateFolderOpen(false)
                              setDeleteOpen(false)
                            }
                          : undefined
                      }
                    />
                  </span>
                )}
              </span>
              <span className="da-gfs-manage-dialog__top-actions">
                {currentIsFile && canWriteCurrent ? (
                  <Button
                    loading={ctrl.mutating}
                    onClick={() => replaceInputRef.current?.click()}
                    size="sm"
                    variant="outline"
                  >
                    Replace file
                  </Button>
                ) : null}
                <IconButton
                  autoFocus
                  label="Close manage dialog"
                  onClick={closeManage}
                  size="sm"
                  variant="ghost"
                >
                  <IconClose />
                </IconButton>
              </span>
            </header>

            {currentIsFile && canWriteCurrent ? (
              <input
                aria-label="Replace file"
                className="visually-hidden"
                ref={replaceInputRef}
                type="file"
                onChange={event => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  void handleReplaceCurrentFile(file)
                }}
              />
            ) : null}

            <div className="da-gfs-manage-dialog__body">
              {currentIsFolder && canWriteCurrent && createFolderOpen ? (
                <form
                  className="da-gfs-inline-form da-gfs-create-folder-form"
                  aria-label="Create folder"
                  onSubmit={event => {
                    event.preventDefault()
                    void handleCreateFolder()
                  }}
                >
                  <div className="da-gfs-create-folder-form__heading">
                    <h4>New folder</h4>
                    <p className="muted">Create a folder in {current.name}.</p>
                  </div>
                  <label className="da-gfs-inline-form__field da-gfs-create-folder-form__field">
                    <span>Folder name</span>
                    <TextInput
                      autoFocus
                      value={createFolderName}
                      onChange={event => setCreateFolderName(event.currentTarget.value)}
                    />
                  </label>
                  <div className="da-gfs-create-folder-form__actions">
                    <Button
                      onClick={() => {
                        setCreateFolderName('')
                        setCreateFolderOpen(false)
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Cancel
                    </Button>
                    <Button loading={ctrl.mutating} size="sm" type="submit">
                      Create folder
                    </Button>
                  </div>
                </form>
              ) : null}
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
                    <h4>Access</h4>
                    <p className="muted">Control who can use this resource and what they can do.</p>
                  </div>
                </div>
                {loadingAffordances ? (
                  <p className="muted">Refreshing permissions…</p>
                ) : affordancesError ? (
                  <StatusBanner tone="error" text={affordancesError} />
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
                    />
                  </>
                ) : (
                  <p className="muted">Loading permissions…</p>
                )}
              </section>

              <section className="da-gfs-manage-section da-gfs-manage-section--grants">
                <div className="da-gfs-manage-section__header">
                  <div>
                    <h4>Who has access</h4>
                    <p className="muted">
                      Existing direct grants and shares on this resource. Revoking is immediate.
                    </p>
                  </div>
                </div>
                <GfsGrantList
                  agents={agentSubjects}
                  error={grantsError}
                  items={ctrl.grants}
                  loading={ctrl.loadingGrants || ctrl.loadingShares}
                  onRevoke={(item, label) => void handleRevokeGrant(item.id, label)}
                  onRevokeShare={(item, label) => void handleRevokeShare(item.id, label)}
                  revoking={ctrl.revoking}
                  revokingShare={ctrl.revokingShare}
                  shareError={sharesError}
                  shares={ctrl.shares}
                  subjects={delegationSubjects}
                />
              </section>
            </div>
          </section>
        </div>
      ) : null}

      {filePreview?.kind === 'image' ? (
        <GfsImagePreview
          byteLength={filePreview.bytes}
          fileName={filePreview.name}
          gfsUri={filePreview.gfsUri}
          mimeType={filePreview.mimeType}
          onClose={() => setFilePreview(null)}
          onDownloadError={handlePreviewDownloadError}
        />
      ) : null}

      {filePreview?.kind === 'markdown' ? (
        <GfsMarkdownPreview
          byteLength={filePreview.bytes}
          fileName={filePreview.name}
          gfsUri={filePreview.gfsUri}
          onClose={() => setFilePreview(null)}
          onDownloadError={handlePreviewDownloadError}
        />
      ) : null}

      {filePreview?.kind === 'video' ? (
        <GfsVideoPreview
          byteLength={filePreview.bytes}
          fileName={filePreview.name}
          gfsUri={filePreview.gfsUri}
          mimeType={filePreview.mimeType}
          onClose={() => setFilePreview(null)}
          onDownloadError={handlePreviewDownloadError}
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
    </section>
  )
}
