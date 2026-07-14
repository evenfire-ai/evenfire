import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@components/Common'
import {
  HTML_PREVIEW_ACTIVE_SANDBOX,
  HTML_PREVIEW_ALLOW_ACTIVE_MODE,
  HTML_PREVIEW_SAFE_SANDBOX,
  HTML_PREVIEW_TIMEOUT_MS,
} from '@constants/htmlPreview'

type SecureHtmlPreviewProps = {
  html: string
  previewId: string
  title: string
  maxBytes: number
  fullscreenOnly?: boolean
  onRequestClose?: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SecureHtmlPreview({
  html,
  previewId,
  title,
  maxBytes,
  fullscreenOnly = false,
  onRequestClose,
}: SecureHtmlPreviewProps) {
  const [loaded, setLoaded] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [activeModeEnabled, setActiveModeEnabled] = useState(false)
  const [fullViewOpen, setFullViewOpen] = useState(false)
  const htmlSizeBytes = useMemo(() => new TextEncoder().encode(html).byteLength, [html])
  const exceedsSizeLimit = htmlSizeBytes > maxBytes

  useEffect(() => {
    setLoaded(false)
    setTimedOut(false)
  }, [html, activeModeEnabled])

  useEffect(() => {
    if (!fullscreenOnly) return
    setFullViewOpen(true)
  }, [fullscreenOnly, html, previewId])

  useEffect(() => {
    if (!fullscreenOnly || fullViewOpen) return
    onRequestClose?.()
  }, [fullViewOpen, fullscreenOnly, onRequestClose])

  useEffect(() => {
    if (!fullViewOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFullViewOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [fullViewOpen])

  useEffect(() => {
    if (loaded || exceedsSizeLimit) return
    const timer = window.setTimeout(() => {
      setTimedOut(true)
    }, HTML_PREVIEW_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [exceedsSizeLimit, loaded, html, activeModeEnabled])

  const handleDownload = () => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safeTitle =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'html-preview'
    link.href = objectUrl
    link.download = `${safeTitle}-${previewId.slice(0, 8)}.html`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(objectUrl)
  }

  const renderInlinePreviewContent = () => {
    if (exceedsSizeLimit) {
      return (
        <p className="message-html-preview-note">
          Preview blocked: HTML exceeds safe limit ({formatBytes(maxBytes)}).
        </p>
      )
    }
    if (timedOut) {
      return (
        <p className="message-html-preview-note">
          Preview timed out. Open the full view or download the file instead.
        </p>
      )
    }
    return (
      <iframe
        className="message-html-preview-frame"
        title={`${title} ${previewId}`}
        sandbox={activeModeEnabled ? HTML_PREVIEW_ACTIVE_SANDBOX : HTML_PREVIEW_SAFE_SANDBOX}
        referrerPolicy="no-referrer"
        loading="lazy"
        srcDoc={html}
        onLoad={() => setLoaded(true)}
      />
    )
  }

  const renderFullscreenPreviewContent = () => {
    return (
      <iframe
        className="message-html-preview-fullscreen-frame"
        title={`${title} full ${previewId}`}
        sandbox={activeModeEnabled ? HTML_PREVIEW_ACTIVE_SANDBOX : HTML_PREVIEW_SAFE_SANDBOX}
        referrerPolicy="no-referrer"
        loading="eager"
        srcDoc={html}
      />
    )
  }

  const fullscreenPortal =
    fullViewOpen &&
    createPortal(
      <div
        className="message-html-preview-fullscreen-overlay"
        onClick={() => setFullViewOpen(false)}
        role="presentation"
      >
        <section
          className="message-html-preview-fullscreen-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={`${title} full view`}
          onClick={event => event.stopPropagation()}
        >
          <header className="message-html-preview-fullscreen-head">
            <div>
              <strong>{title}</strong>
              <p className="muted">{formatBytes(htmlSizeBytes)}</p>
            </div>
            <Button
              className="message-html-preview-fullscreen-close"
              color="neutral"
              onClick={() => setFullViewOpen(false)}
              size="xs"
              variant="ghost"
            >
              Back to chat
            </Button>
          </header>
          {renderFullscreenPreviewContent()}
        </section>
      </div>,
      document.body
    )

  if (fullscreenOnly) {
    return fullscreenPortal || null
  }

  return (
    <div className="message-html-preview" role="group" aria-label={title}>
      <div className="message-html-preview-head">
        <strong>{title}</strong>
        <span className="message-html-preview-badge">{formatBytes(htmlSizeBytes)}</span>
      </div>
      <div className="message-html-preview-warning">
        <span
          aria-label="Untrusted HTML warning"
          className="message-html-preview-warning__icon"
          role="img"
          title="Untrusted HTML preview. Review carefully before interacting."
        >
          !
        </span>
        Untrusted HTML preview. Review carefully before interacting.
      </div>
      <div className="message-html-preview-controls">
        <Button
          className="message-html-preview-open-full-btn"
          color="neutral"
          onClick={() => setFullViewOpen(true)}
          size="xs"
          variant="ghost"
        >
          Open full view
        </Button>
        <Button color="neutral" onClick={handleDownload} size="xs" variant="ghost">
          Download HTML
        </Button>
        {HTML_PREVIEW_ALLOW_ACTIVE_MODE && (
          <Button
            color="neutral"
            onClick={() => setActiveModeEnabled(previous => !previous)}
            size="xs"
            variant="ghost"
          >
            {activeModeEnabled ? 'Disable active HTML' : 'Enable active HTML'}
          </Button>
        )}
      </div>
      {renderInlinePreviewContent()}
      {fullscreenPortal}
    </div>
  )
}
