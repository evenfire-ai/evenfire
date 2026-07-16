import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, EmptyState, IconButton, StatusBanner, TextInput } from '@components/Common'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import {
  IconAttachFile,
  IconChevronRight,
  IconClose,
  IconConnectors,
  IconContexts,
  IconCopy,
  IconDownload,
  IconEdit,
  IconPlus,
  IconTrash,
} from '@components/SidebarNav/icons'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { formatSharedFileSize } from '@lib/sharedFiles'
import { GfsDelegationPanel, type GfsDelegationSubjectOption } from '@/gfs/delegation'
import { GfsFilePicker } from '@/gfs/filePicker'
import { normalizeGfsResourceName } from '@/gfs/resourceName'
import type { TeamDirectoryResult } from '../../../src/types'
import type { FilesPageProps, GfsDriveResource } from './FilesPage.types'

async function fileToEncodedData(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
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

function resourceSource(resource: GfsDriveResource, currentFolderName?: string): string {
  if (currentFolderName) return currentFolderName
  return resource.sources?.length ? resource.sources.join(' + ') : 'Shared'
}

export function FilesPage({ pushToast }: FilesPageProps) {
  const [createFolderName, setCreateFolderName] = useState('')
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [openLinkOpen, setOpenLinkOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const ctrl = useGfsBrowserController()
  const {
    current,
    crumbs,
    accessibleResources,
    items,
    affordances,
    affordancesError,
    loadingAccessible,
    loading,
    accessibleError,
    accessibleNotice,
    error,
    openError,
    resolving,
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
  const canWriteCurrent = hasBit(affordances, 'write')
  const canDeleteCurrent = hasBit(affordances, 'delete')
  const currentIsFolder = current?.kind === 'directory'
  const currentIsFile = current?.kind === 'file'

  useEffect(() => {
    if (!manageOpen && !openLinkOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setManageOpen(false)
      setOpenLinkOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [manageOpen, openLinkOpen])

  const handleGrant = async (subjectKey: string, bits: string[]) => {
    await ctrl.grant(subjectKey, bits)
    pushToast?.('Access granted', 'success')
  }

  const handleCreateShare = async (subjectKey: string) => {
    await ctrl.createShare(subjectKey)
    pushToast?.('Share created', 'success')
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

  const handleUploadFile = async (file: File | null | undefined) => {
    if (!file) return
    try {
      const name = await normalizeGfsResourceName(file.name)
      await ctrl.createFile(name, await fileToEncodedData(file))
      pushToast?.(`Uploaded ${name}`, 'success')
    } catch (uploadError) {
      pushToast?.(uploadError instanceof Error ? uploadError.message : String(uploadError), 'error')
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

  const visibleResources: GfsDriveResource[] = currentIsFolder
    ? items
    : currentIsFile
      ? []
      : accessibleResources
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
    void handleDownload(resource.gfsUri, resource.name)
  }

  return (
    <section className="page da-gfs-page">
      <div className="page-header">
        <h2>Files</h2>
        <p className="muted">Browse and manage everything shared with you in one place.</p>
      </div>

      <div className="page-layout da-gfs-layout">
        <section className="page-card da-gfs-drive" aria-label="Global File System browser">
          <div className="page-card__header da-gfs-drive__header">
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
            <div className="da-gfs-drive__header-actions">
              <Button
                color="neutral"
                onClick={() => setOpenLinkOpen(true)}
                size="sm"
                variant="outline"
              >
                Open GFS link
              </Button>
              {current ? (
                <GfsResourceMenu
                  resourceName={current.name}
                  onManage={() => {
                    setCreateFolderOpen(false)
                    setRenameOpen(false)
                    setDeleteOpen(false)
                    setManageOpen(true)
                  }}
                  onCopyLink={() => void handleCopyLink(current.gfsUri)}
                  onDownload={
                    currentIsFile
                      ? () => void handleDownload(current.gfsUri, current.name)
                      : undefined
                  }
                />
              ) : null}
            </div>
          </div>

          {accessibleNotice ? <StatusBanner tone="info" text={accessibleNotice} /> : null}
          {visibleError ? <StatusBanner tone="error" text={visibleError} /> : null}

          <div className="da-gfs-drive__table-toolbar">
            <span>
              {currentIsFolder
                ? `${visibleResources.length} items in this folder`
                : currentIsFile
                  ? 'File selected'
                  : `${visibleResources.length} shared items`}
            </span>
            <span className="muted">Use the three-dot menu to manage an item.</span>
          </div>

          {visibleLoading ? (
            <EmptyState title="Loading files" body="Fetching your Global File System resources…" />
          ) : currentIsFile ? (
            <EmptyState
              title={current.name}
              body="Use the three-dot menu above to manage, download, or copy this file's link."
            />
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
                  'calc(var(--space-5) + var(--space-1)) minmax(12rem, 1fr) minmax(5rem, 0.35fr) minmax(7rem, 0.55fr) 4.5rem',
              }}
            >
              <div className="da-grid__head">
                <span className="da-grid__col-header" aria-hidden="true" />
                <span className="da-grid__col-header">Name</span>
                <span className="da-grid__col-header da-gfs-drive__type-column">Type</span>
                <span className="da-grid__col-header da-gfs-drive__source-column">Source</span>
                <span className="da-grid__col-header da-grid__col-header--right">Actions</span>
              </div>
              <div className="da-grid__body">
                {visibleResources.map(resource => (
                  <div className="da-grid__row da-grid__row--compact" key={resource.resourceId}>
                    <span className="da-gfs-list__icon da-grid__cell" aria-hidden="true">
                      {resource.kind === 'directory' ? <IconContexts /> : <IconAttachFile />}
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
                          : `${formatSharedFileSize(resource.bytes)} · v${resource.version}`}
                      </span>
                    </span>
                    <span className="da-gfs-drive__type da-grid__cell">
                      {resource.kind === 'directory' ? 'Folder' : 'File'}
                    </span>
                    <span className="da-gfs-drive__source da-grid__cell">
                      {resourceSource(resource, currentIsFolder ? current?.name : undefined)}
                    </span>
                    <span className="da-gfs-list__actions da-grid__cell da-grid__cell--right">
                      <GfsResourceMenu
                        resourceName={resource.name}
                        onManage={() => openManage(resource)}
                        onCopyLink={() => void handleCopyLink(resource.gfsUri)}
                        onOpen={
                          resource.kind === 'directory' ? () => openResource(resource) : undefined
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
                <span className="muted">Paste a GFS URI to jump directly to a shared resource.</span>
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
                onOpen={ctrl.openUri}
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
            aria-labelledby="gfs-manage-title"
          >
            <header className="da-gfs-manage-dialog__header">
              <span
                className={`da-gfs-manage-dialog__icon${currentIsFolder ? ' da-gfs-manage-dialog__icon--folder' : ''}`}
                aria-hidden="true"
              >
                {currentIsFolder ? <IconContexts /> : <IconAttachFile />}
              </span>
              <span className="da-gfs-manage-dialog__heading">
                <span className="da-gfs-eyebrow">Manage {currentIsFolder ? 'folder' : 'file'}</span>
                <h3 id="gfs-manage-title">{current.name}</h3>
                <span className="da-gfs-manage-dialog__meta">
                  <span className="da-gfs-manage-dialog__badge">
                    {currentIsFolder ? 'Folder' : 'File'}
                  </span>
                  <span>Version {current.version}</span>
                  <span>
                    {affordances
                      ? `${affordances.held.length} permission${affordances.held.length === 1 ? '' : 's'}`
                      : 'Checking access'}
                  </span>
                </span>
              </span>
              <IconButton
                autoFocus
                label="Close manage dialog"
                onClick={() => setManageOpen(false)}
                size="sm"
                variant="ghost"
              >
                <IconClose />
              </IconButton>
            </header>

            <div className="da-gfs-manage-dialog__body">
              <section className="da-gfs-manage-section da-gfs-manage-section--actions">
                <div className="da-gfs-manage-section__header">
                  <div>
                    <span className="da-gfs-manage-section__step">Resource</span>
                    <h4>Quick actions</h4>
                    <p className="muted">Only actions available to you are shown.</p>
                  </div>
                </div>

                <div className="da-gfs-manage-resource-link">
                  <span className="da-gfs-manage-resource-link__copy">
                    <span>GFS location</span>
                    <code title={current.gfsUri}>{current.gfsUri}</code>
                  </span>
                  <IconButton
                    label={`Copy GFS link for ${current.name}`}
                    onClick={() => void handleCopyLink(current.gfsUri)}
                    size="sm"
                    title="Copy GFS link"
                    variant="ghost"
                  >
                    <IconCopy />
                  </IconButton>
                </div>

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

                <div className="da-gfs-current-actions da-gfs-current-actions--manage">
                  {currentIsFolder && canWriteCurrent ? (
                    <>
                      <Button
                        align="start"
                        className="da-gfs-manage-action"
                        loading={ctrl.mutating}
                        onClick={() => {
                          setCreateFolderName('')
                          setCreateFolderOpen(true)
                          setRenameOpen(false)
                          setDeleteOpen(false)
                        }}
                        variant="ghost"
                      >
                        <span className="da-gfs-manage-action__icon" aria-hidden="true">
                          <IconPlus />
                        </span>
                        <span className="da-gfs-manage-action__copy">
                          <strong>New folder</strong>
                          <small>Create inside this folder</small>
                        </span>
                      </Button>
                      <Button
                        align="start"
                        className="da-gfs-file-action da-gfs-manage-action"
                        loading={ctrl.mutating}
                        onClick={() => uploadInputRef.current?.click()}
                        variant="ghost"
                      >
                        <span className="da-gfs-manage-action__icon" aria-hidden="true">
                          <IconAttachFile />
                        </span>
                        <span className="da-gfs-manage-action__copy">
                          <strong>Upload file</strong>
                          <small>Add a file to this folder</small>
                        </span>
                      </Button>
                    </>
                  ) : null}
                  {currentIsFile && canWriteCurrent ? (
                    <Button
                      align="start"
                      className="da-gfs-file-action da-gfs-manage-action"
                      loading={ctrl.mutating}
                      onClick={() => replaceInputRef.current?.click()}
                      variant="ghost"
                    >
                      <span className="da-gfs-manage-action__icon" aria-hidden="true">
                        <IconAttachFile />
                      </span>
                      <span className="da-gfs-manage-action__copy">
                        <strong>Replace file</strong>
                        <small>Upload a new version</small>
                      </span>
                    </Button>
                  ) : null}
                  {canWriteCurrent ? (
                    <Button
                      align="start"
                      className="da-gfs-manage-action"
                      loading={ctrl.mutating}
                      onClick={() => {
                        setRenameName(current.name)
                        setRenameOpen(true)
                        setCreateFolderOpen(false)
                        setDeleteOpen(false)
                      }}
                      variant="ghost"
                    >
                      <span className="da-gfs-manage-action__icon" aria-hidden="true">
                        <IconEdit />
                      </span>
                      <span className="da-gfs-manage-action__copy">
                        <strong>Rename</strong>
                        <small>Change the display name</small>
                      </span>
                    </Button>
                  ) : null}
                  {currentIsFile ? (
                    <Button
                      align="start"
                      className="da-gfs-manage-action"
                      onClick={() => void handleDownload(current.gfsUri, current.name)}
                      variant="ghost"
                    >
                      <span className="da-gfs-manage-action__icon" aria-hidden="true">
                        <IconDownload />
                      </span>
                      <span className="da-gfs-manage-action__copy">
                        <strong>Download</strong>
                        <small>Save a local copy</small>
                      </span>
                    </Button>
                  ) : null}
                  {canDeleteCurrent ? (
                    <Button
                      align="start"
                      className="da-gfs-manage-action da-gfs-manage-action--danger"
                      color="danger"
                      loading={ctrl.mutating}
                      onClick={() => {
                        setDeleteOpen(true)
                        setCreateFolderOpen(false)
                        setRenameOpen(false)
                      }}
                      variant="ghost"
                    >
                      <span className="da-gfs-manage-action__icon" aria-hidden="true">
                        <IconTrash />
                      </span>
                      <span className="da-gfs-manage-action__copy">
                        <strong>Delete</strong>
                        <small>Remove this {currentIsFolder ? 'folder' : 'file'}</small>
                      </span>
                    </Button>
                  ) : null}
                </div>

                {canWriteCurrent ? (
                  <StatusBanner tone="warn" compact>
                    For reliable uploads, use raw files around 110 MB or smaller.
                  </StatusBanner>
                ) : null}

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

                {canWriteCurrent && renameOpen ? (
                  <form
                    className="da-gfs-inline-form"
                    aria-label="Rename resource"
                    onSubmit={event => {
                      event.preventDefault()
                      void handleRenameCurrent()
                    }}
                  >
                    <label className="da-gfs-inline-form__field">
                      <span>New name</span>
                      <TextInput
                        autoFocus
                        value={renameName}
                        onChange={event => setRenameName(event.currentTarget.value)}
                      />
                    </label>
                    <Button loading={ctrl.mutating} size="sm" type="submit">
                      Save name
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
                ) : null}

                {canDeleteCurrent && deleteOpen ? (
                  <div
                    className="da-gfs-inline-form"
                    role="alertdialog"
                    aria-label="Delete resource"
                  >
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
              </section>

              <section className="da-gfs-manage-section da-gfs-manage-section--access">
                <div className="da-gfs-manage-section__header">
                  <div>
                    <span className="da-gfs-manage-section__step">Sharing</span>
                    <h4>Access</h4>
                    <p className="muted">Control who can use this resource and what they can do.</p>
                  </div>
                </div>
                {affordancesError ? <StatusBanner tone="error" text={affordancesError} /> : null}
                {affordances ? (
                  <GfsDelegationPanel
                    affordances={affordances}
                    subjectOptions={delegationSubjects}
                    subjectOptionsLoading={teamDirectoryQuery.isFetching}
                    subjectOptionsError={
                      teamDirectoryQuery.error instanceof Error
                        ? teamDirectoryQuery.error.message
                        : teamDirectoryQuery.error
                          ? String(teamDirectoryQuery.error)
                          : null
                    }
                    onGrant={handleGrant}
                    onCreateShare={affordances.canCreateShare ? handleCreateShare : undefined}
                  />
                ) : !affordancesError ? (
                  <p className="muted">Loading permissions…</p>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}
