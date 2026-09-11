'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCopy } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import { Button } from '@components/ui'
import { gfsFetchFileBlob } from '@lib/api'
import { assertGfsImagePreviewSize } from '@lib/gfsImagePreview'
import type { GfsImagePreviewProps } from './types'

export function GfsImagePreview({
  byteLength,
  fileName,
  mimeType,
  onClose,
  rid,
}: GfsImagePreviewProps): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const { showToast } = useToast()

  useEffect(() => {
    const previouslyFocused = document.activeElement
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-preview-close]')?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [onClose])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null

    async function loadPreview(): Promise<void> {
      try {
        assertGfsImagePreviewSize(byteLength)
        const fetched = await gfsFetchFileBlob(rid)
        assertGfsImagePreviewSize(fetched.size)
        if (!active) return
        const blob = new Blob([fetched], { type: mimeType })
        setSourceBlob(blob)
        objectUrl = URL.createObjectURL(blob)
        setPreviewUrl(objectUrl)
      } catch (error) {
        if (!active) return
        setPreviewError(error instanceof Error ? error.message : 'Could not load the image preview')
      }
    }

    void loadPreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [byteLength, mimeType, rid])

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
          if (markCopyState('copied')) {
            showToast(`Copied ${fileName} to the clipboard.`, { tone: 'success' })
          }
          return
        }
      }
      if (navigator.clipboard?.writeText) {
        const dataUrl = await blobToDataUrl(sourceBlob)
        if (!mountedRef.current) return
        await navigator.clipboard.writeText(dataUrl)
        if (!mountedRef.current) return
        if (markCopyState('copied')) {
          showToast(`Copied ${fileName} to the clipboard.`, { tone: 'success' })
        }
      } else {
        if (markCopyState('error')) {
          showToast('Copy failed — check browser clipboard permissions.', { tone: 'error' })
        }
      }
    } catch {
      if (markCopyState('error')) {
        showToast('Copy failed — check browser clipboard permissions.', { tone: 'error' })
      }
    }
  }

  return createPortal(
    <div
      className="cu-modal-backdrop cu-gfs-image-preview-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="cu-gfs-image-preview-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="cu-gfs-image-preview-dialog__header">
          <h3 id={titleId}>{fileName}</h3>
          <div className="cu-gfs-image-preview-dialog__header-actions">
            <Button
              className="cu-gfs-image-preview-dialog__copy"
              variant="ghost"
              aria-label={
                copyState === 'copied' ? 'Copied image to clipboard' : 'Copy image to clipboard'
              }
              disabled={!sourceBlob}
              onClick={() => void copyImageToClipboard()}
            >
              <IconCopy width={18} height={18} />
              <span className="cu-gfs-preview-button__label">
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </span>
            </Button>
            <Button
              className="cu-gfs-image-preview-dialog__close"
              data-preview-close
              variant="ghost"
              aria-label="Close image preview"
              onClick={onClose}
            >
              <IconX width={18} height={18} />
            </Button>
          </div>
        </header>
        <div className="cu-gfs-image-preview-dialog__body">
          {previewError ? (
            <div className="cu-banner cu-banner--error" role="alert">
              {previewError}
            </div>
          ) : null}
          {!previewError && !previewUrl ? (
            <div className="cu-gfs-image-preview-dialog__loading" role="status">
              Loading image preview…
            </div>
          ) : null}
          {previewUrl && !previewError ? (
            <img
              alt={`Preview of ${fileName}`}
              className="cu-gfs-image-preview-dialog__image"
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
