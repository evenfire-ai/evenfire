import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconButton } from '@components/Common'
import type { ComposerImageAttachment } from '../../uiTypes'

const COLOR_INPUT_FALLBACK = `#${'0'.repeat(6)}`

type AnnotationCanvasProps = {
  attachment: ComposerImageAttachment
  onSave: (updated: ComposerImageAttachment) => void
  onClose: () => void
}

function resolveDefaultAnnotationColor() {
  if (typeof window === 'undefined') return COLOR_INPUT_FALLBACK
  const tokenColor = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue('--danger')
    .trim()
  return /^#[0-9a-fA-F]{6}$/.test(tokenColor) ? tokenColor : COLOR_INPUT_FALLBACK
}

export function AnnotationCanvas({ attachment, onSave, onClose }: AnnotationCanvasProps) {
  const [previewIsAnnotating, setPreviewIsAnnotating] = useState(false)
  const [annotationColor, setAnnotationColor] = useState(resolveDefaultAnnotationColor)
  const [annotationBrushPx, setAnnotationBrushPx] = useState(5)
  const [annotationBusy, setAnnotationBusy] = useState(false)
  const [annotationError, setAnnotationError] = useState<string | null>(null)
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const annotationPointerActiveRef = useRef(false)
  const annotationLastPointRef = useRef<{ x: number; y: number } | null>(null)

  const loadImage = useCallback((src: string) => {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Could not load preview image.'))
      image.src = src
    })
  }, [])

  const initializeAnnotationCanvas = useCallback(async () => {
    const canvas = annotationCanvasRef.current
    if (!canvas) return
    const image = await loadImage(attachment.previewDataUrl)
    canvas.width = Math.max(1, image.naturalWidth || image.width || 1)
    canvas.height = Math.max(1, image.naturalHeight || image.height || 1)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas context unavailable.')
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
  }, [loadImage, attachment])

  useEffect(() => {
    if (!previewIsAnnotating) return
    setAnnotationError(null)
    initializeAnnotationCanvas().catch(error => {
      setAnnotationError(error instanceof Error ? error.message : String(error))
    })
  }, [initializeAnnotationCanvas, previewIsAnnotating])

  const getCanvasPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = annotationCanvasRef.current
    if (!canvas) return null
    const bounds = canvas.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return null
    const scaleX = canvas.width / bounds.width
    const scaleY = canvas.height / bounds.height
    return {
      x: (event.clientX - bounds.left) * scaleX,
      y: (event.clientY - bounds.top) * scaleY,
    }
  }, [])

  const handleAnnotationPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = annotationCanvasRef.current
      const context = canvas?.getContext('2d')
      const point = getCanvasPoint(event)
      if (!canvas || !context || !point) return
      annotationPointerActiveRef.current = true
      annotationLastPointRef.current = point
      canvas.setPointerCapture(event.pointerId)
      context.strokeStyle = annotationColor
      context.fillStyle = annotationColor
      context.lineWidth = annotationBrushPx
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.beginPath()
      context.arc(point.x, point.y, annotationBrushPx / 2, 0, Math.PI * 2)
      context.fill()
    },
    [annotationBrushPx, annotationColor, getCanvasPoint]
  )

  const handleAnnotationPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!annotationPointerActiveRef.current) return
      const canvas = annotationCanvasRef.current
      const context = canvas?.getContext('2d')
      const point = getCanvasPoint(event)
      const previous = annotationLastPointRef.current
      if (!canvas || !context || !point || !previous) return
      context.strokeStyle = annotationColor
      context.lineWidth = annotationBrushPx
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.beginPath()
      context.moveTo(previous.x, previous.y)
      context.lineTo(point.x, point.y)
      context.stroke()
      annotationLastPointRef.current = point
    },
    [annotationBrushPx, annotationColor, getCanvasPoint]
  )

  const handleAnnotationPointerEnd = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = annotationCanvasRef.current
    if (canvas && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    annotationPointerActiveRef.current = false
    annotationLastPointRef.current = null
  }, [])

  const readBlobAsDataUrl = useCallback((blob: Blob) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () =>
        reject(reader.error || new Error('Failed reading drawn image payload.'))
      reader.readAsDataURL(blob)
    })
  }, [])

  const handleSaveAnnotatedAttachment = useCallback(async () => {
    const canvas = annotationCanvasRef.current
    if (!canvas) return
    setAnnotationBusy(true)
    setAnnotationError(null)
    try {
      const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, attachment.mimeType, attachment.mimeType === 'image/jpeg' ? 0.9 : 1)
      )
      if (!blob) {
        throw new Error('Could not generate the annotated image.')
      }
      const dataUrl = await readBlobAsDataUrl(blob)
      const base64Index = dataUrl.indexOf('base64,')
      if (base64Index === -1) {
        throw new Error('Could not serialize the annotated image.')
      }
      const nextMimeType = blob.type === 'image/png' ? 'image/png' : 'image/jpeg'
      const nextPreviewUrl =
        typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(blob)
          : dataUrl
      onSave({
        ...attachment,
        mimeType: nextMimeType,
        dataBase64: dataUrl.slice(base64Index + 'base64,'.length),
        sizeBytes: blob.size,
        previewDataUrl: nextPreviewUrl,
      })
      setPreviewIsAnnotating(false)
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : String(error))
    } finally {
      setAnnotationBusy(false)
    }
  }, [onSave, attachment, readBlobAsDataUrl])

  return createPortal(
    <div className="composer-image-preview-overlay" onClick={onClose} role="presentation">
      <div
        className="composer-image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={attachment.name}
        onClick={event => event.stopPropagation()}
      >
        <IconButton
          className="composer-image-preview-close"
          onClick={onClose}
          label="Close image preview"
          size="sm"
          variant="ghost"
        >
          ×
        </IconButton>
        <div className="composer-image-preview-actions">
          {!previewIsAnnotating ? (
            <Button
              color="neutral"
              onClick={() => {
                setAnnotationError(null)
                setPreviewIsAnnotating(true)
              }}
              size="xs"
              variant="ghost"
            >
              Annotate
            </Button>
          ) : (
            <>
              <label className="composer-image-preview-color">
                <span>Color</span>
                <input
                  type="color"
                  value={annotationColor}
                  onChange={event => setAnnotationColor(event.target.value)}
                />
              </label>
              <label className="composer-image-preview-brush">
                <span>Brush</span>
                <input
                  type="range"
                  min={2}
                  max={20}
                  value={annotationBrushPx}
                  onChange={event => setAnnotationBrushPx(Number(event.target.value) || 5)}
                />
              </label>
              <Button
                color="neutral"
                onClick={() => {
                  initializeAnnotationCanvas().catch(error => {
                    setAnnotationError(error instanceof Error ? error.message : String(error))
                  })
                }}
                disabled={annotationBusy}
                size="xs"
                variant="ghost"
              >
                Reset
              </Button>
              <Button
                color="neutral"
                onClick={() => {
                  setPreviewIsAnnotating(false)
                  setAnnotationError(null)
                }}
                disabled={annotationBusy}
                size="xs"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                color="neutral"
                onClick={() => void handleSaveAnnotatedAttachment()}
                disabled={annotationBusy}
                size="xs"
                variant="ghost"
              >
                {annotationBusy ? 'Saving...' : 'Save drawing'}
              </Button>
            </>
          )}
        </div>
        {previewIsAnnotating ? (
          <canvas
            ref={annotationCanvasRef}
            className="composer-image-preview-canvas"
            onPointerDown={handleAnnotationPointerDown}
            onPointerMove={handleAnnotationPointerMove}
            onPointerUp={handleAnnotationPointerEnd}
            onPointerCancel={handleAnnotationPointerEnd}
            onPointerLeave={handleAnnotationPointerEnd}
          />
        ) : (
          <img src={attachment.previewDataUrl} alt={attachment.name} />
        )}
        {annotationError && <p className="composer-image-preview-error">{annotationError}</p>}
        <p className="composer-image-preview-meta">
          {attachment.name} · {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB
        </p>
      </div>
    </div>,
    document.body
  )
}
