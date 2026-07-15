'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { IconFolder, IconServer } from '@components/Sidebar/icons'
import {
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconPencil,
  IconTrash,
  IconUpload,
  IconX,
} from '@components/icons'
import { FileUploadModal } from '@components/FileUploadModal'
import { useToast } from '@components/Toast'
import { Button, TextInput } from '@components/ui'
import { apiGet, apiSend, gfsDownload, isSilentApiError } from '@lib/api'
import { normalizeGfsResourceName } from '@lib/gfsResourceName'
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
}

interface Crumb {
  /** null = the synthetic drive root (listed via /gfs/tree). */
  id: string | null
  rid: string | null
  name: string
}

const DRIVE = 'main'

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

/**
 * Operator browser for the Global File System. It lists the drive tree through
 * control-api and uses the operator-scoped GFS proxy for create, upload,
 * replace, rename, and delete operations while access grants stay on the
 * control-api permission surface.
 */
function ridOfResourceId(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

export function GfsBrowser(): React.JSX.Element {
  const { showToast } = useToast()
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, rid: null, name: '/' }])
  const [items, setItems] = useState<GfsChild[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Operator selects a resource to delegate access on (grant/share panel).
  const [selected, setSelected] = useState<GfsChild | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  // New-folder dialog (replaces the native window.prompt flow).
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createFolderError, setCreateFolderError] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadCandidate, setUploadCandidate] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  // Resource IDs currently streaming a download (disables that row's button).
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(() => new Set())

  const current = crumbs[crumbs.length - 1]
  const currentLabel = current?.name === '/' ? DRIVE : current?.name || DRIVE

  const load = useCallback(async (crumb: Crumb, cursor?: string): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const path =
        crumb.id === null
          ? '/api/v1/gfs/tree'
          : `/api/v1/gfs/resources/${encodeURIComponent(crumb.id)}/children`
      const query: Record<string, string> = { drive: DRIVE }
      if (cursor) query.cursor = cursor
      const page = (await apiGet(path, query)) as TreePage
      if (crumb.id === null && page.rootResourceId) {
        setCrumbs(prev =>
          prev[0]?.id === null
            ? [
                { ...prev[0], id: page.rootResourceId, rid: ridOfResourceId(page.rootResourceId) },
                ...prev.slice(1),
              ]
            : prev
        )
      }
      setItems(prev => (cursor ? [...prev, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
    } catch (err) {
      if (!isSilentApiError(err)) {
        setError(err instanceof Error ? err.message : 'Failed to load the Global File System')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(current)
    // Reload whenever the current folder changes (navigation).
  }, [current, load])

  useEffect(() => {
    if (!selected) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected])

  function openDirectory(child: GfsChild): void {
    if (child.kind !== 'directory') return
    setCrumbs(prev => [...prev, { id: child.resourceId, rid: child.rid, name: child.name }])
  }

  function goToCrumb(index: number): void {
    setCrumbs(crumbs.slice(0, index + 1))
  }

  async function copyGfsUri(uri: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(uri)
      showToast('GFS link copied.', { tone: 'success' })
    } catch {
      showToast('Could not copy the GFS link.', { tone: 'error' })
    }
  }

  async function refreshCurrent(): Promise<void> {
    if (!current) return
    await load(current)
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

  async function uploadFile(file: File | null | undefined): Promise<void> {
    const rid = current?.rid ?? (current?.id ? ridOfResourceId(current.id) : null)
    if (!rid || !file) return
    setUploading(true)
    try {
      const name = await normalizeGfsResourceName(file.name)
      await apiSend('POST', `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(rid)}/children`, {
        name,
        kind: 'file',
        contentBase64: await fileToEncodedData(file),
      })
      showToast('File uploaded.', { tone: 'success' })
      setUploadCandidate(null)
      setUploadOpen(false)
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not upload file.', { tone: 'error' })
    } finally {
      setUploading(false)
    }
  }

  function closeUploadModal(): void {
    if (uploading) return
    setUploadOpen(false)
    setUploadCandidate(null)
  }

  function openManage(child: GfsChild, mode?: 'rename' | 'delete'): void {
    setSelected(child)
    setRenameName(child.name)
    setRenameOpen(mode === 'rename')
    setDeleteOpen(mode === 'delete')
  }

  async function renameResource(child: GfsChild, requestedName: string): Promise<void> {
    if (!requestedName.trim()) return
    try {
      const name = await normalizeGfsResourceName(requestedName.trim())
      if (name === child.name) return
      await apiSend(
        'PATCH',
        `/api/v1/gfs/resources/${encodeURIComponent(child.resourceId)}`,
        { drive: DRIVE, newName: name, ifMatch: child.version },
        { drive: DRIVE }
      )
      showToast('Resource renamed.', { tone: 'success' })
      setSelected(null)
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not rename resource.', {
        tone: 'error',
      })
    }
  }

  async function replaceFile(child: GfsChild, file: File | null | undefined): Promise<void> {
    if (!file) return
    try {
      await apiSend(
        'PUT',
        `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(child.rid)}/content`,
        {
          contentBase64: await fileToEncodedData(file),
          ifMatch: child.version,
        }
      )
      showToast('File replaced.', { tone: 'success' })
      if (selected?.resourceId === child.resourceId) setSelected(null)
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not replace file.', { tone: 'error' })
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
      showToast('Resource deleted.', { tone: 'success' })
      setSelected(null)
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not delete resource.', {
        tone: 'error',
      })
    }
  }

  return (
    <section className="cu-gfs" aria-label="Global File System browser">
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title={
            <>
              <IconFolder /> Global File System
            </>
          }
          subtitle="Browse and manage drive resources and access grants from the admin plane."
        />

        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="cu-gfs-panel">
          <div className="cu-gfs-panel__toolbar">
            <nav aria-label="Breadcrumb" className="cu-gfs-breadcrumb">
              {crumbs.map((crumb, index) => (
                <span className="cu-gfs-breadcrumb__item" key={`${crumb.id ?? 'root'}-${index}`}>
                  {index > 0 ? <IconChevronRight width={14} height={14} /> : null}
                  <button
                    className="cu-gfs-breadcrumb__button"
                    type="button"
                    onClick={() => goToCrumb(index)}
                    aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                  >
                    {crumb.name === '/' ? DRIVE : crumb.name}
                  </button>
                </span>
              ))}
            </nav>
            <div className="cu-gfs-panel__actions">
              <Button
                className="cu-gfs-create-action"
                variant="primary"
                disabled={!current?.id}
                onClick={openNewFolder}
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
              >
                <IconUpload width={18} height={18} />
                Upload file
              </Button>
            </div>
          </div>

          <div className="cu-gfs-list__toolbar">
            <span>{items.length} items</span>
            <span>Use the three-dot menu to manage a resource.</span>
          </div>

          {loading && items.length === 0 ? (
            <p className="cu-gfs__state">Loading resources...</p>
          ) : (
            <div className="cu-gfs-list-frame">
              <div className="cu-gfs-list__head" aria-hidden="true">
                <span />
                <span>Name</span>
                <span>Type</span>
                <span>Size</span>
                <span className="cu-gfs-list__head-actions">Actions</span>
              </div>
              <ul className="cu-gfs-list" aria-label="Current folder resources">
                {items.map(child => (
                  <li className="cu-gfs-list__row" key={child.resourceId}>
                    <span className="cu-gfs-list__icon" aria-hidden="true">
                      {child.kind === 'directory' ? <IconFolder /> : <IconServer />}
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
                          <span>{child.name}</span>
                        )}
                      </span>
                      <span className="cu-gfs-list__meta">Version {child.version}</span>
                    </span>
                    <span className="cu-gfs-list__value">
                      {child.kind === 'directory' ? 'Folder' : 'File'}
                    </span>
                    <span className="cu-gfs-list__value">
                      {child.kind === 'directory' ? '—' : formatBytes(child.bytes)}
                    </span>
                    <span className="cu-gfs-list__actions">
                      {child.kind !== 'directory' ? (
                        <Button
                          className="cu-gfs-list__download"
                          size="sm"
                          variant="ghost"
                          title={`Download ${child.name}`}
                          aria-label={`Download ${child.name}`}
                          disabled={downloadingIds.has(child.resourceId)}
                          onClick={() => void downloadFile(child)}
                        >
                          <IconDownload width={18} height={18} />
                        </Button>
                      ) : null}
                      <GfsResourceMenu
                        resourceName={child.name}
                        resourceUri={child.gfsUri}
                        downloading={downloadingIds.has(child.resourceId)}
                        onManage={() => openManage(child)}
                        onOpen={child.kind === 'directory' ? () => openDirectory(child) : undefined}
                        onDownload={
                          child.kind !== 'directory' ? () => void downloadFile(child) : undefined
                        }
                        onReplace={
                          child.kind !== 'directory'
                            ? file => void replaceFile(child, file)
                            : undefined
                        }
                        onCopyLink={() => void copyGfsUri(child.gfsUri)}
                        onRename={() => openManage(child, 'rename')}
                        onDelete={() => openManage(child, 'delete')}
                      />
                    </span>
                  </li>
                ))}
                {items.length === 0 && !loading ? (
                  <li className="cu-gfs-list__empty">No resources are visible in this folder.</li>
                ) : null}
              </ul>
            </div>
          )}

          {nextCursor ? (
            <Button
              className="cu-gfs__load-more"
              size="sm"
              onClick={() => void load(current, nextCursor)}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </div>

      {selected ? (
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
            aria-labelledby="cu-gfs-manage-title"
          >
            <header className="cu-gfs-manage-dialog__header">
              <span
                className={`cu-gfs-manage-dialog__icon${selected.kind === 'directory' ? ' cu-gfs-manage-dialog__icon--folder' : ''}`}
                aria-hidden="true"
              >
                {selected.kind === 'directory' ? <IconFolder /> : <IconServer />}
              </span>
              <span className="cu-gfs-manage-dialog__heading">
                <span className="cu-gfs__eyebrow">
                  Manage {selected.kind === 'directory' ? 'folder' : 'file'}
                </span>
                <h3 id="cu-gfs-manage-title">{selected.name}</h3>
                <span className="cu-gfs-manage-dialog__meta">
                  <span className="cu-gfs-manage-dialog__badge">
                    {selected.kind === 'directory' ? 'Folder' : 'File'}
                  </span>
                  <span>Version {selected.version}</span>
                  {selected.kind !== 'directory' ? <span>{formatBytes(selected.bytes)}</span> : null}
                </span>
              </span>
              <Button
                className="cu-gfs-manage-dialog__close"
                variant="ghost"
                aria-label="Close manage dialog"
                onClick={() => setSelected(null)}
              >
                <IconX width={18} height={18} />
              </Button>
            </header>

            <div className="cu-gfs-manage-dialog__body">
              <section className="cu-gfs-manage-section cu-gfs-manage-section--actions">
                <div className="cu-gfs-manage-section__header">
                  <span>Resource</span>
                  <h4>Quick actions</h4>
                  <p>Manage this resource without leaving the browser.</p>
                </div>

                <div className="cu-gfs-manage-resource-link">
                  <span>
                    <small>GFS location</small>
                    <code title={selected.gfsUri}>{selected.gfsUri}</code>
                  </span>
                  <Button
                    variant="ghost"
                    aria-label={`Copy GFS link for ${selected.name}`}
                    onClick={() => void copyGfsUri(selected.gfsUri)}
                  >
                    <IconCopy width={17} height={17} />
                  </Button>
                </div>

                <div className="cu-gfs-manage-actions">
                  {selected.kind === 'directory' ? (
                    <Button
                      className="cu-gfs-manage-action"
                      variant="ghost"
                      onClick={() => {
                        setSelected(null)
                        openDirectory(selected)
                      }}
                    >
                      <span className="cu-gfs-manage-action__icon">
                        <IconFolder />
                      </span>
                      <span>
                        <strong>Open folder</strong>
                        <small>Browse its contents</small>
                      </span>
                    </Button>
                  ) : (
                    <>
                      <label className="cu-btn cu-btn--ghost cu-gfs-manage-action cu-gfs-file-action">
                        <span className="cu-gfs-manage-action__icon">
                          <IconUpload width={18} height={18} />
                        </span>
                        <span>
                          <strong>Replace file</strong>
                          <small>Upload a new version</small>
                        </span>
                        <input
                          aria-label={`Replace ${selected.name}`}
                          className="sr-only"
                          type="file"
                          onChange={event => {
                            const file = event.currentTarget.files?.[0]
                            event.currentTarget.value = ''
                            void replaceFile(selected, file)
                          }}
                        />
                      </label>
                      <Button
                        className="cu-gfs-manage-action"
                        variant="ghost"
                        disabled={downloadingIds.has(selected.resourceId)}
                        onClick={() => void downloadFile(selected)}
                      >
                        <span className="cu-gfs-manage-action__icon">
                          <IconDownload width={18} height={18} />
                        </span>
                        <span>
                          <strong>Download</strong>
                          <small>Save a local copy</small>
                        </span>
                      </Button>
                    </>
                  )}
                  <Button
                    className="cu-gfs-manage-action"
                    variant="ghost"
                    onClick={() => {
                      setRenameName(selected.name)
                      setRenameOpen(true)
                      setDeleteOpen(false)
                    }}
                  >
                    <span className="cu-gfs-manage-action__icon">
                      <IconPencil width={18} height={18} />
                    </span>
                    <span>
                      <strong>Rename</strong>
                      <small>Change the display name</small>
                    </span>
                  </Button>
                  <Button
                    className="cu-gfs-manage-action cu-gfs-manage-action--danger"
                    variant="ghost"
                    onClick={() => {
                      setDeleteOpen(true)
                      setRenameOpen(false)
                    }}
                  >
                    <span className="cu-gfs-manage-action__icon">
                      <IconTrash width={18} height={18} />
                    </span>
                    <span>
                      <strong>Delete</strong>
                      <small>Remove this resource</small>
                    </span>
                  </Button>
                </div>

                {renameOpen ? (
                  <form
                    className="cu-gfs-manage-inline-form"
                    aria-label="Rename resource"
                    onSubmit={event => {
                      event.preventDefault()
                      void renameResource(selected, renameName)
                    }}
                  >
                    <label>
                      <span>New name</span>
                      <TextInput
                        autoFocus
                        value={renameName}
                        onChange={event => setRenameName(event.currentTarget.value)}
                      />
                    </label>
                    <Button variant="primary" type="submit" disabled={!renameName.trim()}>
                      Save
                    </Button>
                    <Button variant="ghost" onClick={() => setRenameOpen(false)}>
                      Cancel
                    </Button>
                  </form>
                ) : null}

                {deleteOpen ? (
                  <div
                    className="cu-gfs-manage-inline-form"
                    role="alertdialog"
                    aria-label="Delete resource"
                  >
                    <span>Delete {selected.name}?</span>
                    <Button variant="danger" onClick={() => void deleteResource(selected)}>
                      Delete
                    </Button>
                    <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </section>

              <section className="cu-gfs-manage-section cu-gfs-manage-section--access">
                <div className="cu-gfs-manage-section__header">
                  <span>Sharing</span>
                  <h4>Access</h4>
                  <p>Choose who can use this resource and what they can do.</p>
                </div>
                <GfsGrantPanel
                  resource={{
                    resourceId: selected.resourceId,
                    name: selected.name,
                    gfsUri: selected.gfsUri,
                    kind: selected.kind,
                  }}
                />
              </section>
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

      {uploadOpen ? (
        <FileUploadModal
          busy={uploading}
          file={uploadCandidate}
          fileSummary={uploadCandidate ? `${formatBytes(uploadCandidate.size)} selected` : undefined}
          guidance="For reliable uploads, use files around 110 MB or smaller."
          onClose={closeUploadModal}
          onFileChange={setUploadCandidate}
          onUpload={() => void uploadFile(uploadCandidate)}
        />
      ) : null}
    </section>
  )
}
