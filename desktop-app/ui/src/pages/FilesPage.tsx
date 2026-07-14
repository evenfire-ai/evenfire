import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, EmptyState, IconButton, StatusBanner } from '@components/Common'
import { IconAttachFile, IconContexts, IconCopy } from '@components/SidebarNav/icons'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { GfsDelegationPanel, type GfsDelegationSubjectOption } from '@/gfs/delegation'
import { GfsFilePicker } from '@/gfs/filePicker'
import { normalizeGfsResourceName } from '@/gfs/resourceName'
import type { Tone } from '@/uiTypes'
import type { TeamDirectoryResult } from '../../../src/types'

/**
 * P4-S07 — Desktop "Files" page: the end-user Global File System surface.
 *
 * Journey (covers every user type):
 *  - Any user with a read delegation: sees shared folders/files immediately,
 *    opens a resource, browses children, and downloads files. A plain reader
 *    sees browse-only affordances.
 *  - A folder owner (manage_acl holder — e.g. a team admin): same, plus the
 *    delegation panel appears with exactly the bits they hold (no escalation).
 *
 * All authority is server-side (control-api `/external/gfs/*` on the Session-JWT
 * plane → gfsc, deny-by-default). Affordances only decide which controls to show.
 */

export interface FilesPageProps {
  /** App-level toast dispatcher for success feedback (desktop-app/ui rule). */
  pushToast?: (message: string, tone: Tone) => void
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

function resourceMeta(child: { kind: string; bytes: number; version: number }): string {
  if (child.kind === 'directory') return 'Folder'
  return `File / ${formatBytes(child.bytes)} / v${child.version}`
}

function accessMeta(resource: {
  kind: string
  bytes: number
  version: number
  coversDescendants?: boolean
  sources?: string[]
}): string {
  const scope =
    resource.kind === 'directory' && resource.coversDescendants
      ? 'Folder tree'
      : resourceMeta(resource)
  const source = resource.sources?.length ? ` / ${resource.sources.join(' + ')}` : ''
  return `${scope}${source}`
}

async function fileToEncodedData(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
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

export function FilesPage({ pushToast }: FilesPageProps) {
  const [createFolderName, setCreateFolderName] = useState('')
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
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
      // Defer the revoke: a synchronous revoke right after click() can free the
      // blob before Chromium's download manager has read it (a known race).
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      pushToast?.(`Downloaded ${name}`, 'success')
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleCopyLink = async (uri: string) => {
    try {
      await navigator.clipboard.writeText(uri)
      pushToast?.('GFS link copied', 'success')
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : 'Could not copy the GFS link', 'error')
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
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleUploadFile = async (file: File | null | undefined) => {
    if (!file) return
    try {
      const name = await normalizeGfsResourceName(file.name)
      await ctrl.createFile(name, await fileToEncodedData(file))
      pushToast?.(`Uploaded ${name}`, 'success')
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleReplaceCurrentFile = async (file: File | null | undefined) => {
    if (!file || !current) return
    try {
      await ctrl.replaceFile(current.resourceId, await fileToEncodedData(file), current.version)
      pushToast?.(`Replaced ${current.name}`, 'success')
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : String(e), 'error')
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
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleDeleteCurrent = async () => {
    if (!current) return
    try {
      await ctrl.deleteResource(current.resourceId, current.version)
      setDeleteOpen(false)
      pushToast?.(`Deleted ${current.name}`, 'success')
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  return (
    <section className="page">
      <div className="page-header">
        <h2>Files</h2>
        <p className="muted">
          Browse Global File System resources shared with you, including folders, folder trees, and
          individual files.
        </p>
      </div>
      <div className="page-layout">
        <section className="page-card" aria-label="GFS resources shared with you">
          <div className="da-gfs-card-header">
            <div>
              <p className="da-gfs-eyebrow">Global File System</p>
              <h3>Shared with you</h3>
            </div>
          </div>
          {accessibleNotice ? <StatusBanner tone="info" text={accessibleNotice} /> : null}
          {accessibleError ? <StatusBanner tone="error" text={accessibleError} /> : null}
          {loadingAccessible ? (
            <EmptyState
              title="Loading resources"
              body="Fetching folders and files you can access."
            />
          ) : accessibleResources.length === 0 ? (
            <EmptyState
              title="No GFS resources yet"
              body="Folders, folder trees, and files shared with your user or organization will appear here."
            />
          ) : (
            <ul className="da-gfs-list da-gfs-list--library">
              {accessibleResources.map(resource => (
                <li key={resource.resourceId} className="da-gfs-list__row">
                  <span className="da-gfs-list__icon" aria-hidden="true">
                    {resource.kind === 'directory' ? <IconContexts /> : <IconAttachFile />}
                  </span>
                  <span className="da-gfs-list__identity">
                    <span className="da-gfs-list__name">
                      <Button
                        variant="text"
                        align="start"
                        block
                        onClick={() => ctrl.openResource(resource)}
                      >
                        {resource.name || resource.drive}
                      </Button>
                    </span>
                    <span className="da-gfs-list__meta">{accessMeta(resource)}</span>
                  </span>
                  <span className="da-gfs-list__actions">
                    <IconButton
                      label={`Copy GFS link for ${resource.name || resource.drive}`}
                      size="sm"
                      title={resource.gfsUri}
                      onClick={() => void handleCopyLink(resource.gfsUri)}
                    >
                      <IconCopy />
                    </IconButton>
                    {resource.kind !== 'directory' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDownload(resource.gfsUri, resource.name)}
                      >
                        Download
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {ctrl.hasMoreAccessible ? (
            <Button
              variant="outline"
              size="sm"
              loading={ctrl.isFetchingMoreAccessible}
              onClick={ctrl.loadMoreAccessible}
            >
              Load more
            </Button>
          ) : null}
        </section>

        <section className="page-card">
          <div className="da-gfs-card-header">
            <div>
              <p className="da-gfs-eyebrow">Direct link</p>
              <h3>Open a GFS link</h3>
            </div>
          </div>
          <GfsFilePicker onOpen={ctrl.openUri} busy={resolving} error={openError} />
        </section>

        {current ? (
          <section className="page-card" aria-label="Global File System browser">
            <div className="da-gfs-card-header">
              <div>
                <p className="da-gfs-eyebrow">Current resource</p>
                <h3>{current.name}</h3>
              </div>
              <div className="da-gfs-current-actions">
                {currentIsFolder && canWriteCurrent ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      loading={ctrl.mutating}
                      onClick={() => {
                        setCreateFolderOpen(true)
                        setRenameOpen(false)
                        setDeleteOpen(false)
                      }}
                    >
                      New folder
                    </Button>
                    <label className="ui-button ui-button--outline ui-button--primary ui-button--sm ui-button--align-center da-gfs-file-action">
                      Upload file
                      <input
                        className="visually-hidden"
                        type="file"
                        onChange={event => {
                          const file = event.currentTarget.files?.[0]
                          event.currentTarget.value = ''
                          void handleUploadFile(file)
                        }}
                      />
                    </label>
                  </>
                ) : null}
                {currentIsFile && canWriteCurrent ? (
                  <label className="ui-button ui-button--outline ui-button--primary ui-button--sm ui-button--align-center da-gfs-file-action">
                    Replace
                    <input
                      className="visually-hidden"
                      type="file"
                      onChange={event => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ''
                        void handleReplaceCurrentFile(file)
                      }}
                    />
                  </label>
                ) : null}
                {canWriteCurrent ? (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={ctrl.mutating}
                    onClick={() => {
                      setRenameName(current.name)
                      setRenameOpen(true)
                      setCreateFolderOpen(false)
                      setDeleteOpen(false)
                    }}
                  >
                    Rename
                  </Button>
                ) : null}
                {canDeleteCurrent ? (
                  <Button
                    variant="outline"
                    color="danger"
                    size="sm"
                    loading={ctrl.mutating}
                    onClick={() => {
                      setDeleteOpen(true)
                      setCreateFolderOpen(false)
                      setRenameOpen(false)
                    }}
                  >
                    Delete
                  </Button>
                ) : null}
                {currentIsFile ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDownload(current.gfsUri, current.name)}
                  >
                    Download
                  </Button>
                ) : null}
                <IconButton
                  className="da-gfs-current-copy"
                  size="sm"
                  title={current.gfsUri}
                  label={`Copy GFS link for ${current.name}`}
                  onClick={() => void handleCopyLink(current.gfsUri)}
                >
                  <IconCopy />
                </IconButton>
              </div>
            </div>
            {canWriteCurrent ? (
              <StatusBanner tone="warn" compact>
                GFS uploads currently use JSON/base64. The service accepts 150 MB request bodies, so
                use raw files around 110 MB or smaller until streaming uploads are available.
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
                  <input
                    value={createFolderName}
                    onChange={event => setCreateFolderName(event.currentTarget.value)}
                    autoFocus
                  />
                </label>
                <Button size="sm" type="submit" loading={ctrl.mutating}>
                  Create folder
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => setCreateFolderOpen(false)}
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
                  <input
                    value={renameName}
                    onChange={event => setRenameName(event.currentTarget.value)}
                    autoFocus
                  />
                </label>
                <Button size="sm" type="submit" loading={ctrl.mutating}>
                  Save name
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => setRenameOpen(false)}
                >
                  Cancel
                </Button>
              </form>
            ) : null}
            {canDeleteCurrent && deleteOpen ? (
              <div className="da-gfs-inline-form" role="alertdialog" aria-label="Delete resource">
                <span className="da-gfs-inline-form__copy">Delete {current.name}?</span>
                <Button
                  size="sm"
                  color="danger"
                  loading={ctrl.mutating}
                  onClick={() => void handleDeleteCurrent()}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => setDeleteOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : null}
            <nav aria-label="Breadcrumb" className="da-gfs-breadcrumb">
              {crumbs.map((crumb, index) => (
                <span key={`${crumb.resourceId}-${index}`} className="da-gfs-breadcrumb__item">
                  <Button variant="text" size="sm" onClick={() => ctrl.goToCrumb(index)}>
                    {crumb.name}
                  </Button>
                  {index < crumbs.length - 1 ? (
                    <span className="da-gfs-breadcrumb__sep" aria-hidden="true">
                      /
                    </span>
                  ) : null}
                </span>
              ))}
            </nav>

            {error ? <StatusBanner tone="error" text={error} /> : null}

            {current.kind !== 'directory' ? (
              <EmptyState
                title="File selected"
                body={`${current.name} is ready to download or replace when you have write access.`}
              />
            ) : loading ? (
              <EmptyState title="Loading" body="Fetching folder contents…" />
            ) : items.length === 0 ? (
              <EmptyState title="Empty folder" body="This folder has no entries you can access." />
            ) : (
              <ul className="da-gfs-list">
                {items.map(child => (
                  <li key={child.resourceId} className="da-gfs-list__row">
                    <span className="da-gfs-list__icon" aria-hidden="true">
                      {child.kind === 'directory' ? <IconContexts /> : <IconAttachFile />}
                    </span>
                    <span className="da-gfs-list__identity">
                      <span className="da-gfs-list__name">
                        <Button
                          variant="text"
                          align="start"
                          block
                          onClick={() =>
                            child.kind === 'directory'
                              ? ctrl.openChild(child)
                              : ctrl.openResource(child)
                          }
                        >
                          {child.name}
                        </Button>
                      </span>
                      <span className="da-gfs-list__meta">{resourceMeta(child)}</span>
                    </span>
                    <span className="da-gfs-list__actions">
                      <IconButton
                        className="da-gfs-list__copy"
                        size="sm"
                        title={child.gfsUri}
                        label={`Copy GFS link for ${child.name}`}
                        onClick={() => void handleCopyLink(child.gfsUri)}
                      >
                        <IconCopy />
                      </IconButton>
                      {child.kind !== 'directory' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDownload(child.gfsUri, child.name)}
                        >
                          Download
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {ctrl.hasMore ? (
              <Button
                variant="outline"
                size="sm"
                loading={ctrl.isFetchingMore}
                onClick={ctrl.loadMore}
              >
                Load more
              </Button>
            ) : null}
          </section>
        ) : null}

        {current ? (
          <section className="page-card" aria-label="Delegate access">
            <div className="da-gfs-card-header">
              <div>
                <p className="da-gfs-eyebrow">Permissions</p>
                <h3 className="da-gfs-section-title">Delegate access</h3>
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
        ) : null}
      </div>
    </section>
  )
}
