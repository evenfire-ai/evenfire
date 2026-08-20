import { type DragEvent as ReactDragEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, EmptyState, IconButton, StatusBanner, TextInput } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsImagePreview } from '@components/GfsImagePreview'
import { GfsMarkdownPreview } from '@components/GfsMarkdownPreview'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { GfsVideoPreview } from '@components/GfsVideoPreview'
import {
  IconAttachFile,
  IconChevronRight,
  IconClose,
  IconConnectors,
  IconContexts,
  IconDownload,
  IconEye,
} from '@components/SidebarNav/icons'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
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
import { normalizeGfsResourceName } from '@/gfs/resourceName'
import type { TeamDirectoryResult } from '../../../src/types'
import type {
  FilesPageProps,
  GfsDriveResource,
  GfsPreviewResource,
  MyAgentEntry,
} from './FilesPage.types'

async function fileToEncodedData(file: File): Promise<string> {
  assertGfsFileUploadSize(file.size)
  const bytes = new Uint8Array(await file.arrayBuffer())
  assertGfsFileUploadSize(bytes.byteLength)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function hasBit(affordances: { held?: string[] } | null, bit: string): boolean {
  return Boolean(affordances?.held?.includes(bit))
}

function hasDraggedFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes('Files')
}

function isDroppedPreviewFile(file: File): boolean {
  return (
    file.type.toLowerCase().startsWith('image/') ||
    gfsImagePreviewMimeType(file.name) !== null ||
    isGfsMarkdownPreviewFile(file.name)
  )
}

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

/** Any row/header action target — a listing row (GfsDriveResource) or the
 *  current breadcrumb (GfsCrumb); both carry the identity fields the delete /
 *  rename / move calls need (kind also powers dialog titles + the move cycle
 *  guard). */
type GfsActionTarget = Pick<GfsDriveResource, 'resourceId' | 'name' | 'version'> & {
  kind: 'file' | 'directory'
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
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
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
  const canWriteCurrent = hasBit(affordances, 'write')
  const canDeleteCurrent = hasBit(affordances, 'delete')
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
      setManageOpen(false)
      setOpenLinkOpen(false)
      setMoveTarget(null)
      setRenameTarget(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [manageOpen, openLinkOpen, moveTarget, renameTarget])

  // One atomic bulk grant for every selected subject — the server grants all or
  // none (a `subjects_invalid` rejects the whole request), so there is no
  // partial-success outcome. People, teams, and agents share a single picker;
  // agents are capped to read/write inside the panel. Inherit is honored for
  // directories (default ON) and forced false for files.
  const handleGrant = async (subjectKeys: string[], bits: string[], inherit: boolean) => {
    await ctrl.grant(subjectKeys, bits, inherit)
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
      pushToast?.(describeGfsGrantError(revokeError).message, 'error')
    }
  }

  const handleCreateShare = async (subjectKeys: string[]) => {
    await ctrl.createShare(subjectKeys)
    pushToast?.(
      `${subjectKeys.length} ${subjectKeys.length === 1 ? 'share' : 'shares'} created`,
      'success'
    )
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
    } catch (uploadError) {
      pushToast?.(uploadError instanceof Error ? uploadError.message : String(uploadError), 'error')
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
    const opened = await ctrl.openUri(uri)
    if (opened === false) return false
    if (typeof opened === 'object' && opened.kind === 'file') openFilePreview(opened)
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
      pushToast?.(createError instanceof Error ? createError.message : String(createError), 'error')
    }
  }

  const handleUploadFile = async (
    file: File | null | undefined,
    parentResourceId = current?.resourceId
  ) => {
    if (!file || !parentResourceId) return
    try {
      const name = await normalizeGfsResourceName(file.name)
      await ctrl.createFile(parentResourceId, name, await fileToEncodedData(file))
      pushToast?.(`Uploaded ${name}`, 'success')
    } catch (uploadError) {
      pushToast?.(uploadError instanceof Error ? uploadError.message : String(uploadError), 'error')
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
    const previewFiles = droppedFiles.filter(isDroppedPreviewFile)
    if (!previewFiles.length) {
      pushToast?.('Only image and Markdown files can be dropped here.', 'error')
      return
    }

    setDroppedUploadCount(previewFiles.length)
    try {
      for (const file of previewFiles) {
        await handleUploadFile(file, destinationResourceId)
      }
      const skippedCount = droppedFiles.length - previewFiles.length
      if (skippedCount > 0) {
        pushToast?.(
          `${skippedCount} unsupported ${skippedCount === 1 ? 'file was' : 'files were'} skipped.`,
          'error'
        )
      }
    } finally {
      setDroppedUploadCount(0)
    }
  }

  const handleReplaceCurrentFile = async (file: File | null | undefined) => {
    if (!file || !current) return
    try {
      await ctrl.replaceFile(current.resourceId, await fileToEncodedData(file), current.version)
      pushToast?.(`Replaced ${current.name}`, 'success')
    } catch (replaceError) {
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
      if (name === current.name) return
      await ctrl.renameResource(current.resourceId, name, current.version)
      setRenameOpen(false)
      pushToast?.(`Renamed to ${name}`, 'success')
    } catch (renameError) {
      pushToast?.(renameError instanceof Error ? renameError.message : String(renameError), 'error')
    }
  }

  const handleDeleteCurrent = async () => {
    if (!current) return
    try {
      await ctrl.deleteResource(current.resourceId, current.version)
      setDeleteOpen(false)
      setManageOpen(false)
      pushToast?.(`Deleted ${current.name}`, 'success')
    } catch (deleteError) {
      pushToast?.(deleteError instanceof Error ? deleteError.message : String(deleteError), 'error')
    }
  }

  const handleDeleteResource = async (resource: GfsActionTarget) => {
    try {
      await ctrl.deleteResource(resource.resourceId, resource.version)
      pushToast?.(`Deleted ${resource.name}`, 'success')
    } catch (deleteError) {
      pushToast?.(deleteError instanceof Error ? deleteError.message : String(deleteError), 'error')
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

  /** Move commits bubble their failure back to the dialog (in-place banner);
   *  success toasts and closes it. ifMatch pins the resource version. */
  const handleMoveTarget = async (destinationId: string, destinationName: string) => {
    if (!moveTarget) return
    const target = moveTarget
    await ctrl.moveResource(target.resourceId, destinationId, target.version)
    setMoveTarget(null)
    pushToast?.(`Moved ${target.name} to ${destinationName}`, 'success')
  }

  const requestMoveCurrent = () => {
    if (current) setMoveTarget(current)
  }

  /** Page-level rename works for any row or the current resource; the manage
   *  dialog keeps its own inline title-edit flow. Errors toast (stale version
   *  → retry), matching the manage-dialog rename behavior. */
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
      if (left.kind === right.kind) return 0
      return left.kind === 'directory' ? -1 : 1
    })
  }, [accessibleResources, currentIsFile, currentIsFolder, items])
  const visibleLoading = currentIsFolder ? loading : !current ? loadingAccessible : false
  const visibleError = currentIsFolder ? error : !current ? accessibleError : null
  const hasMoreVisible = currentIsFolder ? ctrl.hasMore : !current && ctrl.hasMoreAccessible
  const loadingMoreVisible = currentIsFolder ? ctrl.isFetchingMore : ctrl.isFetchingMoreAccessible

  const openManage = (resource: GfsDriveResource) => {
    if (resource.resourceId !== current?.resourceId) ctrl.openResource(resource)
    setCreateFolderOpen(false)
    setRenameOpen(false)
    setDeleteOpen(false)
    setManageOpen(true)
  }

  const openResource = (resource: GfsDriveResource) => {
    if (resource.kind === 'directory') {
      if (currentIsFolder) ctrl.openChild(resource)
      else ctrl.openResource(resource)
      return
    }
    if (openFilePreview(resource)) return
    void handleDownload(resource.gfsUri, resource.name)
  }

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
                    <Button
                      className="da-gfs-drive__breadcrumb"
                      color="neutral"
                      disabled={index === crumbs.length - 1}
                      onClick={() => ctrl.goToCrumb(index)}
                      variant="text"
                    >
                      {crumb.name}
                    </Button>
                  </span>
                ))}
              </nav>
              {current && !currentIsFile ? (
                <GfsResourceMenu
                  resourceName={current.name}
                  onManage={() => {
                    setCreateFolderOpen(false)
                    setRenameOpen(false)
                    setDeleteOpen(false)
                    setManageOpen(true)
                  }}
                  onCopyLink={() => void handleCopyLink(current.gfsUri)}
                  onDelete={canDeleteCurrent ? () => setDeleteTarget(current) : undefined}
                  onRename={canWriteCurrent ? () => openRenameTarget(current) : undefined}
                  onMove={requestMoveCurrent}
                />
              ) : null}
            </div>
            <div className="da-gfs-drive__header-actions">
              <Button
                color="neutral"
                onClick={() => setOpenLinkOpen(true)}
                size="sm"
                variant="outline"
              >
                <IconEye width={16} height={16} />
                Open GFS link
              </Button>
            </div>
          </div>

          {dragActive || droppedUploadCount > 0 ? (
            <div className="composer-drop-overlay da-gfs-drop-overlay" role="status">
              {droppedUploadCount > 0
                ? `Uploading ${droppedUploadCount} ${droppedUploadCount === 1 ? 'file' : 'files'}…`
                : droppedUploadRestriction ||
                  `Drop images or Markdown files to upload to ${current?.name || 'this folder'}`}
            </div>
          ) : null}

          {accessibleNotice ? <StatusBanner tone="info" text={accessibleNotice} /> : null}
          {visibleError ? <StatusBanner tone="error" text={visibleError} /> : null}

          {visibleLoading ? (
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
                  <h3>{current.name}</h3>
                  <GfsResourceMenu
                    resourceName={current.name}
                    onManage={() => {
                      setCreateFolderOpen(false)
                      setRenameOpen(false)
                      setDeleteOpen(false)
                      setManageOpen(true)
                    }}
                    onCopyLink={() => void handleCopyLink(current.gfsUri)}
                    onDelete={canDeleteCurrent ? () => setDeleteTarget(current) : undefined}
                    onRename={canWriteCurrent ? () => openRenameTarget(current) : undefined}
                    onMove={requestMoveCurrent}
                    onPreview={
                      currentPreviewAvailable ? () => void openFilePreview(current) : undefined
                    }
                    onDownload={() => void handleDownload(current.gfsUri, current.name)}
                  />
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
                  'calc(var(--space-5) + var(--space-1)) minmax(12rem, 1fr) minmax(5rem, 0.35fr) 4.5rem',
              }}
            >
              <div className="da-grid__head">
                <span className="da-grid__col-header" aria-hidden="true" />
                <span className="da-grid__col-header">Name</span>
                <span className="da-grid__col-header da-gfs-drive__type-column">Type</span>
                <span className="da-grid__col-header da-grid__col-header--right">Actions</span>
              </div>
              <div className="da-grid__body">
                {visibleResources.map(resource => (
                  <div
                    className="da-grid__row da-grid__row--clickable da-grid__row--compact"
                    key={resource.resourceId}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${resource.name || resource.drive}`}
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
                        <Button
                          align="start"
                          block
                          onClick={() => openResource(resource)}
                          variant="text"
                        >
                          {resource.name || resource.drive}
                        </Button>
                      </span>
                      <span className="da-gfs-list__meta">
                        {resource.kind === 'directory'
                          ? resource.coversDescendants
                            ? 'Shared folder tree'
                            : 'Folder'
                          : formatSharedFileSize(resource.bytes)}
                      </span>
                    </span>
                    <span className="da-gfs-drive__type da-grid__cell">
                      {resource.kind === 'directory' ? 'Folder' : 'File'}
                    </span>
                    <span className="da-gfs-list__actions da-grid__cell da-grid__cell--right">
                      {resource.kind === 'file' ? (
                        <IconButton
                          label={`Download ${resource.name}`}
                          onClick={() => void handleDownload(resource.gfsUri, resource.name)}
                          size="sm"
                          variant="ghost"
                        >
                          <IconDownload width={16} height={16} />
                        </IconButton>
                      ) : null}
                      <GfsResourceMenu
                        resourceName={resource.name}
                        onManage={() => openManage(resource)}
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
                ))}
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
            if (event.target === event.currentTarget) setManageOpen(false)
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
                {currentIsFolder && canWriteCurrent ? (
                  <Button
                    loading={ctrl.mutating}
                    onClick={() => uploadInputRef.current?.click()}
                    size="sm"
                    variant="outline"
                  >
                    Upload file
                  </Button>
                ) : null}
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
                  onClick={() => setManageOpen(false)}
                  size="sm"
                  variant="ghost"
                >
                  <IconClose />
                </IconButton>
              </span>
            </header>

            {currentIsFolder && canWriteCurrent ? (
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
            ) : null}
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
                  className="da-gfs-inline-form"
                  aria-label="Create folder"
                  onSubmit={event => {
                    event.preventDefault()
                    void handleCreateFolder()
                  }}
                >
                  <label className="da-gfs-inline-form__field">
                    <span>Folder name</span>
                    <TextInput
                      autoFocus
                      value={createFolderName}
                      onChange={event => setCreateFolderName(event.currentTarget.value)}
                    />
                  </label>
                  <Button loading={ctrl.mutating} size="sm" type="submit">
                    Create folder
                  </Button>
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
                      onCreateShare={affordances.canCreateShare ? handleCreateShare : undefined}
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
                      Existing grants on this resource. Revoking is immediate.
                    </p>
                  </div>
                </div>
                <GfsGrantList
                  agents={agentSubjects}
                  error={grantsError}
                  items={ctrl.grants}
                  loading={ctrl.loadingGrants}
                  onRevoke={(item, label) => void handleRevokeGrant(item.id, label)}
                  revoking={ctrl.revoking}
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
        />
      ) : null}

      {filePreview?.kind === 'markdown' ? (
        <GfsMarkdownPreview
          byteLength={filePreview.bytes}
          fileName={filePreview.name}
          gfsUri={filePreview.gfsUri}
          onClose={() => setFilePreview(null)}
        />
      ) : null}

      {filePreview?.kind === 'video' ? (
        <GfsVideoPreview
          byteLength={filePreview.bytes}
          fileName={filePreview.name}
          gfsUri={filePreview.gfsUri}
          mimeType={filePreview.mimeType}
          onClose={() => setFilePreview(null)}
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
          sessionScope={sessionScope}
          target={moveTarget}
        />
      ) : null}

      {renameTarget ? (
        <div
          className="da-gfs-manage-modal"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setRenameTarget(null)
          }}
        >
          <section
            className="da-gfs-manage-dialog da-gfs-manage-dialog--confirm"
            role="dialog"
            aria-modal="true"
            aria-label="Rename resource"
          >
            <div className="da-gfs-manage-dialog__body">
              <form
                className="da-gfs-inline-form"
                onSubmit={event => {
                  event.preventDefault()
                  void handleRenameTarget()
                }}
              >
                <label className="da-gfs-inline-form__field">
                  <span>New name for {renameTarget.name}</span>
                  <TextInput
                    autoFocus
                    aria-label="New name"
                    value={renameDraft}
                    onChange={event => setRenameDraft(event.currentTarget.value)}
                  />
                </label>
                <Button loading={ctrl.mutating} size="sm" type="submit">
                  Save
                </Button>
                <Button
                  onClick={() => setRenameTarget(null)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </form>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}
