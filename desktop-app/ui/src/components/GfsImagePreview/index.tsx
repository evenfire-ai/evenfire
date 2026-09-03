import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, StatusBanner } from '@components/Common'
import { IconClose, IconCopy } from '@components/SidebarNav/icons'
import { assertGfsImagePreviewSize } from '@lib/gfsImagePreview'
import type { GfsImagePreviewProps } from './types'

const MOBILE_SIDEBAR_QUERY = '(max-width: 900px)'

function readWorkspaceLeft(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0
  if (window.matchMedia?.(MOBILE_SIDEBAR_QUERY).matches) return 0

  const sidebar = document.querySelector<HTMLElement>('.left-nav')
  if (!sidebar) return 0

  const rect = sidebar.getBoundingClientRect()
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  if (rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0) return 0

  return Math.max(0, Math.min(rect.right, viewportWidth))
}

export function GfsImagePreview({
  byteLength,
  fileName,
  gfsUri,
  mimeType,
  onClose,
  onDownloadError,
}: GfsImagePreviewProps) {
  const titleId = useId()
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [workspaceLeft, setWorkspaceLeft] = useState(0)
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const onDownloadErrorRef = useRef(onDownloadError)

  // The preview is portaled to document.body, so its grid would otherwise
  // center against the whole window. Keep the dialog centered in the space to
  // the right of the desktop sidebar as that sidebar is expanded or collapsed.
  useLayoutEffect(() => {
    const measure = (): void => {
      const next = readWorkspaceLeft()
      setWorkspaceLeft(current => (current === next ? current : next))
    }

    measure()
    const sidebar = document.querySelector<HTMLElement>('.left-nav')
    const resizeObserver =
      sidebar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    resizeObserver?.observe(sidebar)

    const mutationObserver =
      sidebar && typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null
    mutationObserver?.observe(sidebar, { attributes: true, attributeFilter: ['class'] })

    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [])

  useEffect(() => {
    onDownloadErrorRef.current = onDownloadError
  }, [onDownloadError])

  useEffect(() => {
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null

    const loadPreview = async () => {
      try {
        assertGfsImagePreviewSize(byteLength)
        const { bytes } = await window.clerum.gfs.download(gfsUri)
        assertGfsImagePreviewSize(bytes.byteLength)
        if (!active) return
        const blob = new Blob([bytes], { type: mimeType })
        setSourceBlob(blob)
        objectUrl = URL.createObjectURL(blob)
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        onDownloadErrorRef.current?.(error)
        setPreviewError(error instanceof Error ? error.message : 'Could not load the image preview')
      }
    }

    void loadPreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, gfsUri, mimeType])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    }
  }, [])

  function markCopyState(state: 'copied' | 'error'): boolean {
    if (!mountedRef.current) return false
    setCopyState(state)
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    copyResetTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyState('idle')
    }, 2000)
    return true
  }

  async function copyImageToClipboard(): Promise<void> {
    if (!sourceBlob || !mountedRef.current) return
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        let clipboardBlob: Blob | null = sourceBlob
        if (!sourceBlob.type.includes('png')) {
          clipboardBlob = await convertBlobToPng(sourceBlob)
        }
        if (!mountedRef.current) return
        if (clipboardBlob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': clipboardBlob })])
          if (!mountedRef.current) return
          markCopyState('copied')
          return
        }
      }
      if (navigator.clipboard?.writeText) {
        const dataUrl = await blobToDataUrl(sourceBlob)
        if (!mountedRef.current) return
        await navigator.clipboard.writeText(dataUrl)
        if (!mountedRef.current) return
        markCopyState('copied')
      } else {
        markCopyState('error')
      }
    } catch {
      markCopyState('error')
    }
  }

  const backdropStyle: CSSProperties | undefined =
    workspaceLeft > 0 ? { left: workspaceLeft, right: 0 } : undefined

  return createPortal(
    <div
      className="da-gfs-image-preview-modal"
      role="presentation"
      style={backdropStyle}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="da-gfs-image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="da-gfs-image-preview-dialog__header">
          <h3 id={titleId}>{fileName}</h3>
          <div className="da-gfs-image-preview-dialog__header-actions">
            <Button
              className="da-gfs-image-preview-dialog__copy"
              aria-label={
                copyState === 'copied' ? 'Copied image to clipboard' : 'Copy image to clipboard'
              }
              color="neutral"
              disabled={!sourceBlob}
              onClick={() => void copyImageToClipboard()}
              variant="ghost"
            >
              <IconCopy width={18} height={18} />
              <span className="da-gfs-preview-button__label">
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </span>
            </Button>
            <Button
              className="da-gfs-image-preview-dialog__close"
              data-preview-close
              ref={closeButtonRef}
              aria-label="Close image preview"
              color="neutral"
              onClick={onClose}
              variant="ghost"
            >
              <IconClose width={18} height={18} />
            </Button>
          </div>
        </header>
        <div className="da-gfs-image-preview-dialog__body">
          {previewError ? <StatusBanner tone="error" text={previewError} /> : null}
          {!previewError && !previewUrl ? (
            <div className="da-gfs-image-preview-dialog__loading" role="status">
              Loading image preview…
            </div>
          ) : null}
          {previewUrl && !previewError ? (
            <img
              alt={`Preview of ${fileName}`}
              className="da-gfs-image-preview-dialog__image"
              onError={() => setPreviewError('This image could not be displayed')}
              src={previewUrl}
            />
          ) : null}
        </div>
      </section>
    </div>,
    document.body
  )
}

async function convertBlobToPng(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap === 'undefined') return null
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  } catch {
    return null
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const result = await new Promise<string | ArrayBuffer | null>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'))
    reader.readAsDataURL(blob)
  })
  if (typeof result !== 'string') throw new Error('Could not read the image')
  return result
}

export type { GfsImagePreviewProps } from './types'
