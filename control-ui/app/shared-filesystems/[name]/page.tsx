'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { DataTable, TableViewport } from '@clerum/frontend-components'
import { FileUploadModal } from '@components/FileUploadModal'
import { RowActionsMenu } from '@components/RowActionsMenu'
import { CONTROL_ROUTES } from '@constants/routes'
import { useConfirmDialog } from '../../../components/ConfirmDialog'
import { CreateFlowPanel } from '../../../components/CreateFlowPanel'
import { CreatePageHeader } from '../../../components/CreatePageHeader'
import { DashboardLayout } from '../../../components/DashboardLayout'
import { IconFolder, IconServer } from '../../../components/Sidebar/icons'
import { SkeletonTableRows } from '../../../components/SkeletonTableRows'
import { TableHeaderRow } from '../../../components/TableHeaderRow'
import type { TableHeaderColumn } from '../../../components/TableHeaderRow/types'
import { useToast } from '../../../components/Toast'
import { IconRefresh, IconX } from '../../../components/icons'
import {
  type SharedFileSystemResource,
  type WfcDirEntry,
  getSharedFileSystem,
  isSilentApiError,
  sfsDelete,
  sfsDownload,
  sfsListFiles,
  sfsMkdir,
  sfsMove,
  sfsOpenOrDownload,
  sfsUpload,
} from '../../../lib/api'

const DELETE_ENTRY_REFRESH_DELAY_MS = 800
const DELETE_ENTRY_REFRESH_ATTEMPTS = 4

const FILE_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name', minWidth: '14rem' },
  { key: 'size', label: 'Size', width: '9rem' },
  { key: 'modified', label: 'Modified', width: '14rem' },
  { key: 'actions', width: '17rem', align: 'right', ariaLabel: 'Actions' },
]

/**
 * File browser for a single SharedFileSystem. All file IO goes through
 * control-api's /admin/shared-filesystems/:name/proxy/v1/* — control-api
 * mints a wfc browsing token before forwarding to the per-SFS wfc Service.
 *
 * Admin-only. Per-team RBAC is deferred to a later iteration; the v1 policy
 * is "all writes require admin auth", which the proxy already enforces.
 */
export default function SharedFileSystemDetailsPage() {
  const params = useParams<{ name: string }>()
  const router = useRouter()
  const { showToast } = useToast()

  const sfsName = decodeURIComponent(params.name || '')

  const [meta, setMeta] = useState<SharedFileSystemResource | null>(null)
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<WfcDirEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [entriesLoading, setEntriesLoading] = useState(true)
  const [error, setError] = useState('')
  const [showMkdir, setShowMkdir] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [showRename, setShowRename] = useState<{ from: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [mkdirDraft, setMkdirDraft] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragCounter = useRef(0)
  type UploadItem = {
    name: string
    status: 'pending' | 'uploading' | 'done' | 'error'
    error?: string
  }
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const { confirm, confirmDialog } = useConfirmDialog()

  const breadcrumbs = useMemo(() => {
    const segments = path.split('/').filter(Boolean)
    return segments.map((seg, i) => ({
      label: seg,
      path: segments.slice(0, i + 1).join('/'),
    }))
  }, [path])

  const loadMeta = useCallback(async () => {
    try {
      const r = await getSharedFileSystem(sfsName)
      setMeta(r)
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load SharedFileSystem')
    }
  }, [sfsName])

  const loadEntries = useCallback(
    async (options: { silent?: boolean; toastOnError?: boolean } = {}) => {
      const { silent = false, toastOnError = false } = options
      if (!silent) {
        setBusy(true)
        setEntriesLoading(true)
      }
      setError('')
      try {
        const r = await sfsListFiles(sfsName, path)
        const nextEntries = r.data.entries.sort((a, b) => {
          // Directories first, then alphabetic.
          if (a.kind !== b.kind) {
            if (a.kind === 'directory') return -1
            if (b.kind === 'directory') return 1
          }
          return a.name.localeCompare(b.name)
        })
        setEntries(nextEntries)
        return nextEntries
      } catch (e) {
        if (isSilentApiError(e)) return null
        const message = e instanceof Error ? e.message : 'Failed to load files'
        if (toastOnError) showToast(message, { tone: 'error' })
        else setError(message)
        return null
      } finally {
        if (!silent) {
          setBusy(false)
          setEntriesLoading(false)
        }
      }
    },
    [sfsName, path, showToast]
  )

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  function joinPath(parent: string, child: string): string {
    if (!parent) return child
    return `${parent.replace(/\/+$/, '')}/${child}`
  }

  function navigateTo(next: string) {
    setEntries([])
    setEntriesLoading(true)
    setPath(next)
    setError('')
  }

  function flashError(e: unknown, fallback: string) {
    const msg = e instanceof Error ? e.message : fallback
    setError(msg)
  }

  async function waitForEntryRemoval(entryName: string) {
    for (let attempt = 0; attempt < DELETE_ENTRY_REFRESH_ATTEMPTS; attempt++) {
      await delay(DELETE_ENTRY_REFRESH_DELAY_MS)
      const latest = await loadEntries({
        silent: true,
        toastOnError: attempt === DELETE_ENTRY_REFRESH_ATTEMPTS - 1,
      })
      if (!latest) return
      if (!latest.some(item => item.name === entryName)) return
    }

    showToast(`"${entryName}" is still visible. Refresh again in a moment.`, {
      tone: 'info',
      durationMs: 5000,
    })
  }

  async function onMkdir() {
    if (!mkdirDraft.trim()) return
    setBusy(true)
    setError('')
    try {
      await sfsMkdir(sfsName, joinPath(path, mkdirDraft.trim()))
      showToast(`Created directory ${mkdirDraft.trim()}.`, { tone: 'success' })
      setMkdirDraft('')
      setShowMkdir(false)
      await loadEntries()
    } catch (e) {
      flashError(e, 'Failed to create directory')
    } finally {
      setBusy(false)
    }
  }

  async function onUpload() {
    if (!uploadFile) return
    setBusy(true)
    setError('')
    try {
      const target = joinPath(path, uploadFile.name)
      await sfsUpload(sfsName, target, uploadFile, 'create')
      showToast(`Uploaded ${uploadFile.name}.`, { tone: 'success' })
      setUploadFile(null)
      setShowUpload(false)
      await loadEntries()
    } catch (e) {
      flashError(e, 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  function resetUploadDialog() {
    setShowUpload(false)
    setUploadFile(null)
  }

  async function uploadMany(files: File[]) {
    if (files.length === 0) return
    setError('')
    setUploads(files.map(f => ({ name: f.name, status: 'pending' as const })))
    let successes = 0
    let failures = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      setUploads(prev => prev.map((u, idx) => (idx === i ? { ...u, status: 'uploading' } : u)))
      try {
        await sfsUpload(sfsName, joinPath(path, f.name), f, 'create')
        successes++
        setUploads(prev => prev.map((u, idx) => (idx === i ? { ...u, status: 'done' } : u)))
      } catch (e) {
        failures++
        const msg = e instanceof Error ? e.message : 'Upload failed'
        setUploads(prev =>
          prev.map((u, idx) => (idx === i ? { ...u, status: 'error', error: msg } : u))
        )
      }
    }
    if (failures === 0) {
      showToast(`Uploaded ${successes} file${successes === 1 ? '' : 's'}.`, { tone: 'success' })
    } else setError(`${failures} of ${files.length} uploads failed`)
    await loadEntries()
    // Auto-clear the upload list after a short delay if everything succeeded.
    if (failures === 0) {
      setTimeout(() => setUploads([]), 2000)
    }
  }

  function onDropFiles(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    dragCounter.current = 0
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length > 0) void uploadMany(files)
  }

  async function onDelete(entry: WfcDirEntry) {
    const target = joinPath(path, entry.name)
    const isDir = entry.kind === 'directory'
    const message = isDir
      ? `Delete directory "${entry.name}" and ALL its contents? This cannot be undone.`
      : `Delete "${entry.name}"?`
    const shouldDelete = await confirm({
      title: isDir ? 'Delete Directory' : 'Delete File',
      message,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return
    setBusy(true)
    setError('')
    try {
      await sfsDelete(sfsName, target, isDir)
      showToast(`Deleted ${isDir ? 'folder' : 'file'} "${entry.name}".`, { tone: 'success' })
      const latest = await loadEntries({ silent: true, toastOnError: true })
      if (latest?.some(item => item.name === entry.name)) {
        void waitForEntryRemoval(entry.name)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : `Failed to delete ${entry.name}`, {
        tone: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  async function openOrDownloadFile(entryName: string, targetPath: string) {
    const previewWindow =
      typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null
    try {
      await sfsOpenOrDownload(sfsName, targetPath, previewWindow)
    } catch (e) {
      if (previewWindow && !previewWindow.closed) previewWindow.close()
      flashError(e, `Failed to open ${entryName}`)
    }
  }

  async function onRename() {
    if (!showRename || !renameDraft.trim()) return
    const fromAbs = joinPath(path, showRename.from)
    const toAbs = joinPath(path, renameDraft.trim())
    if (fromAbs === toAbs) {
      setShowRename(null)
      return
    }
    setBusy(true)
    setError('')
    try {
      await sfsMove(sfsName, fromAbs, toAbs)
      showToast(`Renamed to ${renameDraft.trim()}.`, { tone: 'success' })
      setShowRename(null)
      setRenameDraft('')
      await loadEntries()
    } catch (e) {
      flashError(e, 'Rename failed')
    } finally {
      setBusy(false)
    }
  }

  if (entriesLoading && !meta) {
    return (
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          className="cu-detail-flow-panel"
          header={
            <CreatePageHeader
              icon={<IconFolder />}
              title={sfsName || 'Agent Files'}
              backLabel="Back to Agent Files"
              backDisabled
              onBack={() => router.push(CONTROL_ROUTES.agentFiles.root)}
            />
          }
        >
          {null}
        </CreateFlowPanel>
        <div className="cu-card cu-shared-files-detail-card">
          <div className="cu-card__body cu-shared-files-detail">
            <div className="cu-shared-files-detail__toolbar">
              <div className="cu-chip-row" aria-label="Loading shared filesystem metadata">
                {Array.from({ length: 4 }).map((_, idx) => (
                  <span
                    key={idx}
                    className="cu-skeleton cu-skeleton--cell cu-shared-files-detail-skeleton__chip"
                  />
                ))}
              </div>
              <div className="cu-shared-files-detail__actions">
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--toolbar"
                  aria-label="Refreshing files"
                  disabled
                >
                  <IconRefresh className="cu-spin" width={18} height={18} />
                </button>
                <button type="button" className="cu-btn cu-btn--ghost cu-btn--sm" disabled>
                  New folder
                </button>
                <button type="button" className="cu-btn cu-btn--primary cu-btn--sm" disabled>
                  Upload file
                </button>
              </div>
            </div>
            <TableViewport className="cu-table-wrap">
              <DataTable className="eft-table cu-table">
                <thead>
                  <TableHeaderRow columns={FILE_COLUMNS} />
                </thead>
                <tbody>
                  <SkeletonTableRows columns={FILE_COLUMNS.length} rows={5} />
                </tbody>
              </DataTable>
            </TableViewport>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  const phase = meta?.status?.phase
  const capacityLabel = meta?.status?.capacity || meta?.spec?.size || '—'
  const storageClassLabel = meta?.status?.storageClassName || meta?.spec?.storageClassName || '—'
  const accessModeLabels = (meta?.spec?.accessModes || []).map(formatAccessMode)
  const mountedByContexts = meta?.status?.mountedByContexts || []
  const mountLabel =
    mountedByContexts.length === 0
      ? 'not mounted by any Context'
      : `mounted by ${mountedByContexts.map(c => c.name).join(', ')}`
  const metadataTags = [
    phase,
    capacityLabel,
    storageClassLabel,
    ...accessModeLabels,
    mountLabel,
  ].filter(isMetadataTag)

  return (
    <DashboardLayout isDetailPage>
      <CreateFlowPanel
        className="cu-detail-flow-panel"
        header={
          <CreatePageHeader
            icon={<IconFolder />}
            title={sfsName}
            backLabel="Back to Agent Files"
            onBack={() => router.push(CONTROL_ROUTES.agentFiles.root)}
          />
        }
      >
        {null}
      </CreateFlowPanel>

      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

      <div
        className={`cu-card cu-shared-files-detail-card${
          dragOver ? ' cu-shared-files-detail-card--drag-over' : ''
        }`}
        onDragEnter={e => {
          e.preventDefault()
          e.stopPropagation()
          dragCounter.current += 1
          if (e.dataTransfer.types.includes('Files')) setDragOver(true)
        }}
        onDragOver={e => {
          e.preventDefault()
          e.stopPropagation()
          if (e.dataTransfer.types.includes('Files')) e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={e => {
          e.preventDefault()
          e.stopPropagation()
          dragCounter.current -= 1
          if (dragCounter.current <= 0) {
            dragCounter.current = 0
            setDragOver(false)
          }
        }}
        onDrop={onDropFiles}
      >
        {dragOver ? (
          <div className="cu-shared-files-detail-card__drop-overlay">
            Drop files to upload to {path ? `/${path}` : `${sfsName}/`}
          </div>
        ) : null}
        <div className="cu-card__body cu-shared-files-detail">
          {uploads.length > 0 ? (
            <div className="cu-shared-files-detail__uploads">
              <strong>
                Uploads ({uploads.filter(u => u.status === 'done').length}/{uploads.length} done)
              </strong>
              <ul className="cu-shared-files-detail__upload-list">
                {uploads.map(u => (
                  <li key={u.name} className="cu-shared-files-detail__upload-item">
                    <span>{u.name}</span>
                    <span
                      className={
                        u.status === 'done'
                          ? 'cu-badge cu-badge--ok'
                          : u.status === 'error'
                            ? 'cu-badge cu-badge--error'
                            : 'cu-badge'
                      }
                      title={u.error}
                    >
                      {u.status === 'pending' && 'Queued'}
                      {u.status === 'uploading' && 'Uploading…'}
                      {u.status === 'done' && 'Done'}
                      {u.status === 'error' && (u.error || 'Failed')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* Metadata and breadcrumbs */}
          <div className="cu-shared-files-detail__toolbar">
            <div className="cu-shared-files-detail__metadata">
              <div className="cu-chip-row" aria-label="Shared filesystem metadata">
                {metadataTags.map((tag, idx) => (
                  <span key={`${tag}-${idx}`} className="cu-chip">
                    {tag}
                  </span>
                ))}
              </div>
              {breadcrumbs.length > 0 ? (
                <div className="cu-shared-files-detail__breadcrumbs">
                  {breadcrumbs.map((crumb, i) => (
                    <React.Fragment key={crumb.path}>
                      {i > 0 ? <span className="cu-muted">/</span> : null}
                      <button
                        type="button"
                        className={`cu-link${
                          i === breadcrumbs.length - 1
                            ? ' cu-shared-files-detail__breadcrumb-current'
                            : ''
                        }`}
                        onClick={() => navigateTo(crumb.path)}
                        disabled={i === breadcrumbs.length - 1}
                      >
                        {crumb.label}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="cu-shared-files-detail__actions">
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={() => void loadEntries()}
                disabled={busy || entriesLoading}
                aria-label={entriesLoading ? 'Refreshing files' : 'Refresh files'}
              >
                <IconRefresh
                  className={entriesLoading ? 'cu-spin' : undefined}
                  width={18}
                  height={18}
                />
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowMkdir(true)}
                disabled={busy}
              >
                New folder
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() => setShowUpload(true)}
                disabled={busy}
              >
                Upload file
              </button>
            </div>
          </div>

          {/* File listing */}
          {entries.length === 0 && !entriesLoading ? (
            <div className="cu-empty">
              {path ? 'This folder is empty.' : 'This SharedFileSystem is empty.'} Drag &amp; drop
              files here to upload.
            </div>
          ) : (
            <TableViewport className="cu-table-wrap">
              <DataTable className="eft-table cu-table">
                <thead>
                  <TableHeaderRow columns={FILE_COLUMNS} />
                </thead>
                <tbody>
                  {entriesLoading ? (
                    <SkeletonTableRows columns={4} rows={5} />
                  ) : (
                    entries.map(entry => {
                      const isDir = entry.kind === 'directory'
                      const targetPath = joinPath(path, entry.name)
                      return (
                        <tr key={entry.name}>
                          <td>
                            {isDir ? (
                              <button
                                type="button"
                                className="cu-link cu-file-entry-name"
                                onClick={() => navigateTo(targetPath)}
                              >
                                <span className="cu-file-entry-name__icon" aria-hidden="true">
                                  <IconFolder />
                                </span>
                                <span>{entry.name}</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="cu-link cu-file-entry-name cu-file-entry-name--file"
                                onClick={() => void openOrDownloadFile(entry.name, targetPath)}
                                disabled={busy}
                                aria-label={`Open or download ${entry.name}`}
                              >
                                <span className="cu-file-entry-name__icon" aria-hidden="true">
                                  <IconServer />
                                </span>
                                <span>{entry.name}</span>
                              </button>
                            )}
                          </td>
                          <td>{isDir ? '—' : formatBytes(entry.size)}</td>
                          <td>{formatDate(entry.mtime)}</td>
                          <td className="cu-table__cell-actions">
                            <RowActionsMenu
                              ariaLabel={`Actions for ${entry.name}`}
                              actions={[
                                ...(!isDir
                                  ? [
                                      {
                                        key: 'download',
                                        label: 'Download',
                                        disabled: busy,
                                        onClick: async () => {
                                          try {
                                            await sfsDownload(sfsName, targetPath)
                                          } catch (e) {
                                            flashError(e, `Failed to download ${entry.name}`)
                                          }
                                        },
                                      },
                                    ]
                                  : []),
                                {
                                  key: 'rename',
                                  label: 'Rename',
                                  disabled: busy,
                                  onClick: () => {
                                    setShowRename({ from: entry.name })
                                    setRenameDraft(entry.name)
                                  },
                                },
                                {
                                  key: 'delete',
                                  label: 'Delete',
                                  danger: true,
                                  disabled: busy,
                                  onClick: () => void onDelete(entry),
                                },
                              ]}
                            />
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </DataTable>
            </TableViewport>
          )}
        </div>
      </div>

      {/* mkdir modal */}
      {showMkdir && (
        <ModalShell title="New folder" onClose={() => !busy && setShowMkdir(false)}>
          <div className="cu-field">
            <label htmlFor="mkdir-name">Folder name</label>
            <input
              id="mkdir-name"
              className="cu-input"
              value={mkdirDraft}
              onChange={e => setMkdirDraft(e.target.value)}
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="cu-modal-panel__foot">
            <button
              type="button"
              className="cu-btn cu-btn--ghost cu-btn--sm"
              onClick={() => setShowMkdir(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary"
              onClick={() => void onMkdir()}
              disabled={busy || !mkdirDraft.trim()}
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </ModalShell>
      )}

      {/* upload modal */}
      {showUpload && (
        <FileUploadModal
          busy={busy}
          destination={joinPath(path, uploadFile?.name || '<selected-file>') || '<selected-file>'}
          file={uploadFile}
          fileSummary={uploadFile ? `${formatBytes(uploadFile.size)} selected` : undefined}
          onClose={resetUploadDialog}
          onFileChange={setUploadFile}
          onUpload={() => void onUpload()}
        />
      )}

      {/* rename modal */}
      {showRename && (
        <ModalShell
          title={`Rename ${showRename.from}`}
          onClose={() => !busy && setShowRename(null)}
        >
          <div className="cu-field">
            <label htmlFor="rename-name">New name</label>
            <input
              id="rename-name"
              className="cu-input"
              value={renameDraft}
              onChange={e => setRenameDraft(e.target.value)}
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="cu-modal-panel__foot">
            <button
              type="button"
              className="cu-btn cu-btn--ghost cu-btn--sm"
              onClick={() => setShowRename(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary"
              onClick={() => void onRename()}
              disabled={busy || !renameDraft.trim() || renameDraft.trim() === showRename.from}
            >
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </ModalShell>
      )}
      {confirmDialog}
    </DashboardLayout>
  )
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="cu-modal-panel cu-modal-panel--shared-files"
        role="dialog"
        aria-label={title}
        onClick={e => e.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 className="cu-modal-panel__title">{title}</h3>
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--ghost"
            onClick={onClose}
            aria-label="Close"
          >
            <IconX width={18} height={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatAccessMode(accessMode: string): string {
  switch (accessMode) {
    case 'ReadWriteOnce':
      return 'RWO'
    case 'ReadWriteMany':
      return 'RWX'
    case 'ReadOnlyMany':
      return 'ROX'
    case 'ReadWriteOncePod':
      return 'RWOP'
    default:
      return accessMode
  }
}

function isMetadataTag(value: string | undefined): value is string {
  return Boolean(value && value !== '—')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
