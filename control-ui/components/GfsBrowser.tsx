'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FileUploadModal } from '@components/FileUploadModal'
import { GfsImagePreview } from '@components/GfsImagePreview'
import { GfsMarkdownPreview } from '@components/GfsMarkdownPreview'
import { GfsVideoPreview } from '@components/GfsVideoPreview'
import {
  IconDocumentText,
  IconFolder,
  IconImage,
  IconServer,
  IconVideo,
} from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconChevronRight, IconDownload, IconPaperclip, IconUpload, IconX } from '@components/icons'
import { Button, TextInput } from '@components/ui'
import { apiGet, apiSend, gfsDownload, isSilentApiError } from '@lib/api'
import { isGfsDocumentFile } from '@lib/gfsDocumentFile'
import {
  GfsUploadCapabilityError,
  type GfsUploadJob,
  type GfsUploadJobInput,
  type GfsUploadJobSnapshot,
  assertGfsFileUploadSize,
  createGfsUploadJob,
  uploadGfsFileLegacy,
} from '@lib/gfsFileUpload'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import { isGfsMarkdownPreviewFile } from '@lib/gfsMarkdownPreview'
import { normalizeGfsResourceName } from '@lib/gfsResourceName'
import { isGfsVideoFile } from '@lib/gfsVideoFile'
import { gfsVideoPreviewMimeType } from '@lib/gfsVideoPreview'
import { GfsGrantPanel } from './GfsGrantPanel'
import type { GfsCreateShareActionChange } from './GfsGrantPanel.types'
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
const PENDING_GFS_UPLOAD_KEY = 'evenfire:gfs-upload-v2:pending'

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

export function GfsBrowser(): React.JSX.Element {
  const { showToast } = useToast()
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, rid: null, name: '/' }])
  const [items, setItems] = useState<GfsChild[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  // Operator selects a resource to delegate access on (grant/share panel).
  const [selected, setSelected] = useState<GfsChild | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const createShareActionRef = useRef<(() => void) | null>(null)
  const [createShareDisabled, setCreateShareDisabled] = useState(true)
  const handleCreateShareActionChange = useCallback<GfsCreateShareActionChange>(
    (action, disabled) => {
      createShareActionRef.current = action
      setCreateShareDisabled(disabled)
    },
    []
  )
  // New-folder dialog (replaces the native window.prompt flow).
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createFolderError, setCreateFolderError] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadCandidate, setUploadCandidate] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const uploadJobRef = useRef<GfsUploadJob | null>(null)
  const [uploadSnapshot, setUploadSnapshot] = useState<GfsUploadJobSnapshot | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [droppedUploadCount, setDroppedUploadCount] = useState(0)
  const [imagePreview, setImagePreview] = useState<{
    byteLength: number
    fileName: string
    mimeType: string
    rid: string
  } | null>(null)
  const [markdownPreview, setMarkdownPreview] = useState<{
    byteLength: number
    fileName: string
    rid: string
  } | null>(null)
  const [videoPreview, setVideoPreview] = useState<{
    byteLength: number
    fileName: string
    mimeType: string
    rid: string
  } | null>(null)
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
  const currentLabel = current?.name === '/' ? DRIVE : current?.name || DRIVE

  const load = useCallback(async (crumb: Crumb, cursor?: string): Promise<void> => {
    const appending = Boolean(cursor)
    if (appending) {
      setLoadingMore(true)
    } else {
      setLoading(true)
      setItems([])
      setNextCursor(null)
    }
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
      const sortedItems = sortChildrenWithDirectoriesFirst(page.items)
      setItems(prev => (cursor ? [...prev, ...sortedItems] : sortedItems))
      setNextCursor(page.nextCursor)
    } catch (err) {
      if (!isSilentApiError(err)) {
        setError(err instanceof Error ? err.message : 'Failed to load the Global File System')
      }
    } finally {
      if (appending) setLoadingMore(false)
      else setLoading(false)
    }
  }, [])

  function sortChildrenWithDirectoriesFirst(children: GfsChild[]): GfsChild[] {
    return [...children].sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name)
      return a.kind === 'directory' ? -1 : 1
    })
  }

  // Cache of prefetched directory children, keyed by the folder's
  // resourceId. Refs over state because we don't want to re-render
  // every time a prefetch resolves — the data is consumed lazily in
  // openDirectory(). Survives across navigation; cleared on unmount.
  const childCacheRef = useRef<Map<string, TreePage>>(new Map())
  // True after openDirectory() served cached data; the next useEffect
  // pass skips the redundant load() so the user keeps seeing the
  // cached rows instead of a flash of empty items + spinner.
  const skipNextLoadRef = useRef(false)

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

  useEffect(() => {
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false
      return
    }
    void load(current)
    // Reload whenever the current folder changes (navigation).
  }, [current, load])

  useEffect(() => {
    if (!selected || imagePreview || markdownPreview || videoPreview) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [imagePreview, markdownPreview, videoPreview, selected])

  function openDirectory(child: GfsChild): void {
    if (child.kind !== 'directory') return
    setCrumbs(prev => [...prev, { id: child.resourceId, rid: child.rid, name: child.name }])
    const cached = childCacheRef.current.get(child.resourceId)
    if (cached) {
      // Render the cached listing immediately. The useEffect-driven
      // load() will refresh in the background and overwrite if the
      // server state diverged, so the user still gets fresh data —
      // they just don't see the loading spinner.
      setItems(sortChildrenWithDirectoriesFirst(cached.items))
      setNextCursor(cached.nextCursor)
      setError('')
      setLoading(false)
      skipNextLoadRef.current = true
      return
    }
    setLoading(true)
  }

  function openFilePreview(child: GfsChild): boolean {
    if (child.kind === 'directory') return false
    const mimeType = gfsImagePreviewMimeType(child.name)
    if (mimeType) {
      setImagePreview({
        byteLength: child.bytes,
        fileName: child.name,
        mimeType,
        rid: child.rid,
      })
      return true
    }
    if (isGfsMarkdownPreviewFile(child.name)) {
      setMarkdownPreview({ byteLength: child.bytes, fileName: child.name, rid: child.rid })
      return true
    }
    const videoMimeType = gfsVideoPreviewMimeType(child.name)
    if (videoMimeType) {
      setVideoPreview({
        byteLength: child.bytes,
        fileName: child.name,
        mimeType: videoMimeType,
        rid: child.rid,
      })
      return true
    }
    return false
  }

  function goToCrumb(index: number): void {
    if (index === crumbs.length - 1) return
    setLoading(true)
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
          'The persisted resumable session cannot be resumed while GFS Upload v2 is unavailable.',
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

  async function uploadFile(file: File | null | undefined): Promise<void> {
    const rid = current?.rid ?? (current?.id ? ridOfResourceId(current.id) : null)
    if (!rid || !file) return
    setUploading(true)
    let resumeUploadId: string | undefined
    try {
      assertGfsFileUploadSize(file.size)
      const name = await normalizeGfsResourceName(file.name)
      const target = { operation: 'create' as const, parentRid: rid }
      resumeUploadId = matchingPendingResumeUploadId(file, target, name)
      const job = createGfsUploadJob({
        file,
        name,
        target,
        resumeUploadId,
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
      showToast('File uploaded.', { tone: 'success' })
      setUploadCandidate(null)
      setUploadOpen(false)
      setUploadSnapshot(null)
      uploadJobRef.current = null
      await refreshCurrent()
    } catch (err) {
      if (uploadJobRef.current?.snapshot().state === 'aborted') return
      if (err instanceof GfsUploadCapabilityError && err.allowLegacyFallback) {
        if (resumeUploadId) {
          showToast(
            'The persisted resumable session cannot be resumed while GFS Upload v2 is unavailable.',
            { tone: 'error' }
          )
          return
        }
        showToast('Resumable upload is unavailable; using the legacy 16 MiB path.', {
          tone: 'info',
        })
        try {
          const name = await normalizeGfsResourceName(file.name)
          await uploadGfsFileLegacy({ file, name, target: { operation: 'create', parentRid: rid } })
          clearPendingGfsUpload()
          showToast('File uploaded.', { tone: 'success' })
          setUploadCandidate(null)
          setUploadOpen(false)
          setUploadSnapshot(null)
          uploadJobRef.current = null
          await refreshCurrent()
          return
        } catch (legacyError) {
          showToast(legacyError instanceof Error ? legacyError.message : 'Could not upload file.', {
            tone: 'error',
          })
          return
        }
      }
      showToast(err instanceof Error ? err.message : 'Could not upload file.', { tone: 'error' })
    } finally {
      setUploading(false)
    }
  }

  function handleGfsDragEnter(event: React.DragEvent<HTMLElement>): void {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    setDragActive(true)
  }

  function handleGfsDragOver(event: React.DragEvent<HTMLElement>): void {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = current?.id ? 'copy' : 'none'
    setDragActive(true)
  }

  function handleGfsDragLeave(event: React.DragEvent<HTMLElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragActive(false)
  }

  async function handleGfsDrop(event: React.DragEvent<HTMLElement>): Promise<void> {
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
    try {
      for (const file of droppedFiles) {
        await uploadFile(file)
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
    <section
      className="cu-gfs"
      aria-label="Global File System browser"
      aria-busy={loading || droppedUploadCount > 0}
    >
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
              <IconPaperclip /> Global File System
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

        <div className="cu-gfs-panel">
          <div className="cu-gfs-panel__toolbar">
            <nav aria-label="Breadcrumb" className="cu-gfs-breadcrumb">
              {crumbs.map((crumb, index) => (
                <span className="cu-gfs-breadcrumb__item" key={`${crumb.id ?? 'root'}-${index}`}>
                  {index > 0 ? <IconChevronRight width={14} height={14} /> : null}
                  <button
                    className={`cu-gfs-breadcrumb__button${
                      crumb.name === '/' ? ' cu-gfs-breadcrumb__button--root' : ''
                    }`}
                    type="button"
                    onClick={() => goToCrumb(index)}
                    aria-current={index === crumbs.length - 1 ? 'page' : undefined}
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
                  const openRow = () => {
                    if (child.kind === 'directory') openDirectory(child)
                    else openFilePreview(child)
                  }
                  return (
                    <li
                      className={`cu-gfs-list__row${rowOpenable ? ' cu-gfs-list__row--clickable' : ''}`}
                      key={child.resourceId}
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
                          onRename={() => openManage(child, 'rename')}
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
            aria-label={`Manage ${selected.kind === 'directory' ? 'folder' : 'file'} ${selected.name}`}
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
                {renameOpen ? (
                  <form
                    className="cu-gfs-manage-dialog__title-edit"
                    aria-label="Rename resource"
                    onSubmit={event => {
                      event.preventDefault()
                      void renameResource(selected, renameName)
                    }}
                  >
                    <TextInput
                      aria-label="New name"
                      autoFocus
                      value={renameName}
                      onChange={event => setRenameName(event.currentTarget.value)}
                    />
                    <Button variant="primary" size="sm" type="submit" disabled={!renameName.trim()}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenameOpen(false)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <span className="cu-gfs-manage-dialog__title-row">
                    <h3>{selected.name}</h3>
                    <GfsResourceMenu
                      createShareDisabled={createShareDisabled}
                      resourceName={selected.name}
                      resourceUri={selected.gfsUri}
                      downloading={downloadingIds.has(selected.resourceId)}
                      onPreview={
                        selected.kind !== 'directory' && isGfsPreviewFile(selected.name)
                          ? () => openFilePreview(selected)
                          : undefined
                      }
                      onDownload={
                        selected.kind !== 'directory'
                          ? () => void downloadFile(selected)
                          : undefined
                      }
                      onCopyLink={() => void copyGfsUri(selected.gfsUri)}
                      onCreateShare={() => createShareActionRef.current?.()}
                      onRename={() => {
                        setRenameName(selected.name)
                        setRenameOpen(true)
                        setDeleteOpen(false)
                      }}
                      onReplace={
                        selected.kind !== 'directory'
                          ? file => void replaceFile(selected, file)
                          : undefined
                      }
                      onDelete={() => {
                        setDeleteOpen(true)
                        setRenameOpen(false)
                      }}
                    />
                  </span>
                )}
              </span>
              <span className="cu-gfs-manage-dialog__top-actions">
                <Button
                  autoFocus
                  className="cu-gfs-manage-dialog__close"
                  variant="ghost"
                  aria-label="Close manage dialog"
                  onClick={() => setSelected(null)}
                >
                  <IconX width={18} height={18} />
                </Button>
              </span>
            </header>

            <div className="cu-gfs-manage-dialog__body">
              <section className="cu-gfs-manage-section cu-gfs-manage-section--access">
                <div className="cu-gfs-manage-section__header">
                  <h4>Access</h4>
                  <p>Control who can use this resource and what they can do.</p>
                </div>
                <GfsGrantPanel
                  resource={{
                    resourceId: selected.resourceId,
                    name: selected.name,
                    gfsUri: selected.gfsUri,
                    kind: selected.kind,
                  }}
                  onCreateShareActionChange={handleCreateShareActionChange}
                />
              </section>
            </div>
          </section>
        </div>
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

      {uploadOpen ? (
        <FileUploadModal
          busy={uploading}
          file={uploadCandidate}
          fileSummary={
            uploadCandidate ? `${formatBytes(uploadCandidate.size)} selected` : undefined
          }
          guidance="The writer advertises the Upload v2 file limit (up to the 1 GiB protocol maximum); each request is streamed in 8 MiB parts (16 MiB hard maximum)."
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
          byteLength={imagePreview.byteLength}
          fileName={imagePreview.fileName}
          mimeType={imagePreview.mimeType}
          rid={imagePreview.rid}
          onClose={() => setImagePreview(null)}
        />
      ) : null}

      {markdownPreview ? (
        <GfsMarkdownPreview
          byteLength={markdownPreview.byteLength}
          fileName={markdownPreview.fileName}
          rid={markdownPreview.rid}
          onClose={() => setMarkdownPreview(null)}
        />
      ) : null}

      {videoPreview ? (
        <GfsVideoPreview
          byteLength={videoPreview.byteLength}
          fileName={videoPreview.fileName}
          mimeType={videoPreview.mimeType}
          rid={videoPreview.rid}
          onClose={() => setVideoPreview(null)}
        />
      ) : null}
    </section>
  )
}
