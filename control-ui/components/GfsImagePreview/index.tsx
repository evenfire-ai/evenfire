'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCopy } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import { Button } from '@components/ui'
import { gfsFetchFileBlob } from '@lib/api'
import {
  getCachedGfsBlob,
  releaseCachedGfsBlob,
  retainCachedGfsBlob,
  setCachedGfsBlob,
} from '@lib/gfsBlobCache'
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
      // If the row thumbnail already paid the proxy round-trip for this
      // resource, reuse its object URL and skip the network entirely.
      const cached = getCachedGfsBlob(rid)
      if (cached && retainCachedGfsBlob(rid, cached.blobUrl)) {
        objectUrl = cached.blobUrl
        if (!active) return
        // Reconstruct the Blob from the same bytes the thumbnail cached
        // would require keeping the Blob alive; instead we copy the
        // cached object URL and let the modal revoke its own reference
        // when it unmounts (sharing the URL is fine — the browser keeps
        // the blob alive until every reference revokes).
        setPreviewUrl(cached.blobUrl)
        // The cached blob is reachable only through the object URL; for
        // the "Copy" affordance we still need a Blob. Issue a fetch on
        // the object URL to materialise it cheaply.
        try {
          const cachedBlob = await (await fetch(cached.blobUrl)).blob()
          if (active) setSourceBlob(cachedBlob)
        } catch {
          /* Copy will surface the error in copyImageToClipboard. */
        }
        return
      }

      try {
        assertGfsImagePreviewSize(byteLength)
        const fetched = await gfsFetchFileBlob(rid)
        assertGfsImagePreviewSize(fetched.size)
        if (!active) return
        const blob = new Blob([fetched], { type: mimeType })
        setSourceBlob(blob)
        const cachedEntry = setCachedGfsBlob(rid, {
          blobUrl: URL.createObjectURL(blob),
          mimeType: blob.type,
        })
        objectUrl = cachedEntry.blobUrl
        // Publish to the cache so the next preview open skips the network.
        // This preview holds one reference until its cleanup runs.
        setPreviewUrl(cachedEntry.blobUrl)
      } catch (error) {
        if (!active) return
        setPreviewError(error instanceof Error ? error.message : 'Could not load the image preview')
      }
    }

    void loadPreview()
    return () => {
      active = false
      // Release this preview's reference. The cache revokes the URL only
      // after the last thumbnail or preview consumer leaves.
      if (objectUrl) releaseCachedGfsBlob(rid, objectUrl)
    }
  }, [byteLength, mimeType, rid])

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    }
  }, [])

  async function copyImageToClipboard(): Promise<void> {
    if (!sourceBlob) return
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        let clipboardBlob: Blob | null = sourceBlob
        if (!sourceBlob.type.includes('png')) {
          clipboardBlob = await convertBlobToPng(sourceBlob)
        }
        if (clipboardBlob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': clipboardBlob })])
          setCopyState('copied')
          showToast(`Copied ${fileName} to the clipboard.`, { tone: 'success' })
          if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
          copyResetTimeoutRef.current = setTimeout(() => setCopyState('idle'), 2000)
          return
        }
      }
      if (navigator.clipboard?.writeText && previewUrl) {
        await navigator.clipboard.writeText(previewUrl)
        setCopyState('copied')
        showToast(`Copied a ${fileName} link to the clipboard.`, { tone: 'success' })
      } else {
        setCopyState('error')
        showToast('Copy failed — check browser clipboard permissions.', { tone: 'error' })
      }
    } catch {
      setCopyState('error')
      showToast('Copy failed — check browser clipboard permissions.', { tone: 'error' })
    }
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    copyResetTimeoutRef.current = setTimeout(() => setCopyState('idle'), 2000)
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

export type { GfsImagePreviewProps } from './types'
