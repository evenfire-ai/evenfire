import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@components/Common'
import { HTML_PREVIEW_ARTIFACT_MAX_BYTES } from '@constants/htmlPreview'
import { extractArtifactNames } from '@lib/artifacts'

type MessageArtifactActionsProps = {
  hostRef: string
  content: string
}

type ArtifactInfo = {
  name: string
  format: string
  sizeBytes: number
  createdAt: string
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    const copy = new Uint8Array(view.byteLength)
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    return copy.buffer
  }
  if (value && typeof value === 'object') {
    const maybeBuffer = value as { data?: unknown }
    if (Array.isArray(maybeBuffer.data)) {
      return new Uint8Array(maybeBuffer.data.map(n => Number(n) || 0)).buffer
    }
  }
  throw new Error('Unexpected artifact payload shape')
}

function isHtmlArtifact(filename: string): boolean {
  return /\.html?$/i.test(filename)
}

function isMarkdownArtifact(filename: string): boolean {
  return /\.md$/i.test(filename)
}

function supportsPreview(filename: string): boolean {
  return isHtmlArtifact(filename) || isMarkdownArtifact(filename)
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getArtifactFormatLabel(artifact: ArtifactInfo): string {
  const format = artifact.format || artifact.name.split('.').pop() || 'file'
  return format.toUpperCase()
}

function getArtifactFormatClassName(artifact: ArtifactInfo): string {
  return getArtifactFormatLabel(artifact)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
}

function getArtifactTypeLabel(artifact: ArtifactInfo): string {
  const format = (artifact.format || artifact.name.split('.').pop() || '').toLowerCase()
  if (format === 'md') return 'Markdown'
  if (format === 'pdf') return 'PDF'
  if (format === 'docx') return 'Word document'
  if (format === 'xlsx') return 'Spreadsheet'
  if (format === 'pptx') return 'Presentation'
  if (format === 'png') return 'PNG image'
  if (format === 'html' || format === 'htm') return 'HTML'
  if (format === 'json') return 'JSON'
  if (format === 'csv') return 'CSV'
  if (format === 'txt') return 'Text'
  return 'File'
}

function triggerBrowserDownload(filename: string, buffer: ArrayBuffer) {
  const blob = new Blob([buffer])
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function decodeText(buffer: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(buffer)
}

export function MessageArtifactActions({ hostRef, content }: MessageArtifactActionsProps) {
  const mentionedFilenames = useMemo(() => extractArtifactNames(content), [content])
  const [availableArtifacts, setAvailableArtifacts] = useState<ArtifactInfo[] | null>(null)
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null)
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [loadingPreviewFile, setLoadingPreviewFile] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [previewOpenByFile, setPreviewOpenByFile] = useState<Record<string, boolean>>({})
  const [htmlPreviewByFile, setHtmlPreviewByFile] = useState<Record<string, string>>({})
  const [markdownPreviewByFile, setMarkdownPreviewByFile] = useState<Record<string, string>>({})
  const [previewBlockedByFile, setPreviewBlockedByFile] = useState<Record<string, string>>({})
  const [fullscreenHtmlFile, setFullscreenHtmlFile] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadArtifactCatalog() {
      if (!hostRef || mentionedFilenames.length === 0) {
        setAvailableArtifacts(null)
        return
      }
      setCatalogLoading(true)
      setAvailableArtifacts(null)
      setCatalogUnavailable(false)
      setActionError(null)
      try {
        const result = await window.clerum.rpc.listArtifacts(hostRef, [hostRef])
        if (cancelled) return
        setAvailableArtifacts((result.artifacts || []).filter(item => item.name))
        setCatalogUnavailable(false)
      } catch (error) {
        if (cancelled) return
        setAvailableArtifacts([])
        setCatalogUnavailable(true)
      } finally {
        if (!cancelled) setCatalogLoading(false)
      }
    }
    void loadArtifactCatalog()
    return () => {
      cancelled = true
    }
  }, [hostRef, mentionedFilenames])

  const artifacts = useMemo(() => {
    if (!availableArtifacts) return []
    if (catalogUnavailable) {
      return mentionedFilenames.map(name => {
        const format = name.split('.').pop() || 'file'
        return {
          name,
          format,
          sizeBytes: 0,
          createdAt: '',
        }
      })
    }
    const artifactByLowerName = new Map(
      availableArtifacts.map(artifact => [artifact.name.toLowerCase(), artifact])
    )
    return mentionedFilenames
      .map(name => artifactByLowerName.get(name.toLowerCase()))
      .filter((artifact): artifact is ArtifactInfo => Boolean(artifact))
  }, [availableArtifacts, catalogUnavailable, mentionedFilenames])

  const filenames = useMemo(() => artifacts.map(artifact => artifact.name), [artifacts])

  useEffect(() => {
    setPreviewOpenByFile(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([filename]) => filenames.includes(filename))
      )
    )
    setHtmlPreviewByFile(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([filename]) => filenames.includes(filename))
      )
    )
    setMarkdownPreviewByFile(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([filename]) => filenames.includes(filename))
      )
    )
    setPreviewBlockedByFile(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([filename]) => filenames.includes(filename))
      )
    )
  }, [filenames])

  const closeFullscreenHtml = () => {
    setFullscreenHtmlFile(previous => {
      if (previous) {
        setPreviewOpenByFile(current => ({ ...current, [previous]: false }))
      }
      return null
    })
  }

  useEffect(() => {
    if (!fullscreenHtmlFile) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFullscreenHtml()
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [fullscreenHtmlFile])

  if (!hostRef || mentionedFilenames.length === 0) return null

  async function fetchArtifactBuffer(filename: string): Promise<ArrayBuffer> {
    const payload = await window.clerum.rpc.downloadArtifact(hostRef, filename, [hostRef])
    return toArrayBuffer(payload)
  }

  async function handleDownload(filename: string) {
    setDownloadingFile(filename)
    setActionError(null)
    try {
      const buffer = await fetchArtifactBuffer(filename)
      triggerBrowserDownload(filename, buffer)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloadingFile(null)
    }
  }

  async function handleDownloadAll() {
    setDownloadingAll(true)
    setActionError(null)
    try {
      for (const artifact of artifacts) {
        const buffer = await fetchArtifactBuffer(artifact.name)
        triggerBrowserDownload(artifact.name, buffer)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloadingAll(false)
    }
  }

  async function handleTogglePreview(filename: string) {
    if (previewOpenByFile[filename]) {
      setPreviewOpenByFile(previous => ({ ...previous, [filename]: false }))
      return
    }

    setPreviewOpenByFile({ [filename]: true })
    if (isHtmlArtifact(filename) && htmlPreviewByFile[filename]) {
      setFullscreenHtmlFile(filename)
      return
    }
    if (htmlPreviewByFile[filename] || markdownPreviewByFile[filename]) {
      return
    }

    setLoadingPreviewFile(filename)
    setActionError(null)
    try {
      const buffer = await fetchArtifactBuffer(filename)
      const needsTextSafetyLimit = isHtmlArtifact(filename) || isMarkdownArtifact(filename)
      if (needsTextSafetyLimit && buffer.byteLength > HTML_PREVIEW_ARTIFACT_MAX_BYTES) {
        setPreviewBlockedByFile(previous => ({
          ...previous,
          [filename]: `Preview blocked: file exceeds safe limit (${Math.round(
            HTML_PREVIEW_ARTIFACT_MAX_BYTES / 1024
          )} KB). Download to inspect.`,
        }))
        return
      }
      if (isHtmlArtifact(filename)) {
        const html = decodeText(buffer)
        setHtmlPreviewByFile(previous => ({ ...previous, [filename]: html }))
        setFullscreenHtmlFile(filename)
      } else if (isMarkdownArtifact(filename)) {
        const markdown = decodeText(buffer)
        setMarkdownPreviewByFile(previous => ({ ...previous, [filename]: markdown }))
      }
      setPreviewBlockedByFile(previous => {
        const next = { ...previous }
        delete next[filename]
        return next
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      setPreviewOpenByFile(previous => ({ ...previous, [filename]: false }))
    } finally {
      setLoadingPreviewFile(null)
    }
  }

  const visiblePreviews = filenames.filter(
    filename =>
      supportsPreview(filename) && previewOpenByFile[filename] && !isHtmlArtifact(filename)
  )

  if (!catalogLoading && availableArtifacts && artifacts.length === 0 && !actionError) return null

  return (
    <div className="message-artifact-actions">
      {catalogLoading && (
        <p className="message-artifact-note muted">Checking generated artifacts...</p>
      )}
      {catalogUnavailable && artifacts.length > 0 && (
        <p className="message-artifact-note muted">
          Artifact catalog is unavailable right now. You can still try direct downloads.
        </p>
      )}
      {artifacts.length > 0 && (
        <section className="message-artifact-panel" aria-label="Generated files">
          <header className="message-artifact-panel-header">
            <span className="message-artifact-panel-title">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.5 2.5h4.2L12 5.8v7.7H4.5z" />
                <path d="M8.7 2.5v3.3H12" />
              </svg>
              Generated files
            </span>
            {artifacts.length > 1 && (
              <Button
                className="message-artifact-download-all-btn"
                color="primary"
                onClick={() => void handleDownloadAll()}
                disabled={downloadingAll || Boolean(downloadingFile)}
                size="xs"
                variant="text"
              >
                <span>{downloadingAll ? 'Downloading...' : 'Download all'}</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 2.5v7" />
                  <path d="m4.8 6.6 3.2 3.2 3.2-3.2" />
                  <path d="M3.5 12.5h9" />
                </svg>
              </Button>
            )}
          </header>
          <div className="message-artifact-list">
            {artifacts.map(artifact => (
              <div key={artifact.name} className="message-artifact-item">
                <span
                  className={`message-artifact-format message-artifact-format--${getArtifactFormatClassName(
                    artifact
                  )}`}
                >
                  {getArtifactFormatLabel(artifact)}
                </span>
                <span className="message-artifact-file-copy">
                  <span className="message-artifact-filename">{artifact.name}</span>
                  <span className="message-artifact-meta">
                    {getArtifactTypeLabel(artifact)}
                    <span aria-hidden="true"> · </span>
                    {formatSize(artifact.sizeBytes)}
                  </span>
                </span>
                <span className="message-artifact-actions-cell">
                  {supportsPreview(artifact.name) && (
                    <Button
                      type="button"
                      className="message-artifact-preview-btn"
                      onClick={() => void handleTogglePreview(artifact.name)}
                      color="neutral"
                      disabled={loadingPreviewFile === artifact.name}
                      aria-label={
                        previewOpenByFile[artifact.name]
                          ? `Hide ${artifact.name}`
                          : `Preview ${artifact.name}`
                      }
                      title={
                        previewOpenByFile[artifact.name]
                          ? `Hide ${artifact.name}`
                          : `Preview ${artifact.name}`
                      }
                      size="xs"
                      variant="text"
                    >
                      {loadingPreviewFile === artifact.name
                        ? 'Rendering...'
                        : previewOpenByFile[artifact.name]
                          ? 'Hide'
                          : 'Preview'}
                    </Button>
                  )}
                  <Button
                    className="message-artifact-download-btn"
                    color="primary"
                    onClick={() => void handleDownload(artifact.name)}
                    disabled={downloadingFile === artifact.name || downloadingAll}
                    aria-label={`Download ${artifact.name}`}
                    size="sm"
                    title={`Download ${artifact.name}`}
                    variant="soft"
                  >
                    <span>{downloadingFile === artifact.name ? 'Downloading...' : 'Download'}</span>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 2.5v7" />
                      <path d="m4.8 6.6 3.2 3.2 3.2-3.2" />
                      <path d="M3.5 12.5h9" />
                    </svg>
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {visiblePreviews.map(filename => (
        <div key={filename} className="message-artifact-html-preview">
          <div className="message-artifact-html-preview-head">
            <strong>{filename}</strong>
          </div>
          {previewBlockedByFile[filename] ? (
            <p className="message-html-preview-note">{previewBlockedByFile[filename]}</p>
          ) : markdownPreviewByFile[filename] ? (
            <div className="message-artifact-markdown-preview markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {markdownPreviewByFile[filename] || ''}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="muted">Preparing preview...</p>
          )}
        </div>
      ))}
      {fullscreenHtmlFile &&
        htmlPreviewByFile[fullscreenHtmlFile] &&
        createPortal(
          <div
            className="message-html-preview-fullscreen-overlay"
            onClick={closeFullscreenHtml}
            role="presentation"
          >
            <section
              className="message-html-preview-fullscreen-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`Artifact preview: ${fullscreenHtmlFile}`}
              onClick={event => event.stopPropagation()}
            >
              <header className="message-html-preview-fullscreen-head">
                <div>
                  <strong>{`Artifact preview: ${fullscreenHtmlFile}`}</strong>
                  <p className="muted">Untrusted HTML preview</p>
                </div>
                <Button
                  className="ghost-btn mini-btn message-html-preview-fullscreen-close"
                  color="neutral"
                  onClick={closeFullscreenHtml}
                  size="xs"
                  variant="ghost"
                >
                  Back to chat
                </Button>
              </header>
              <iframe
                className="message-html-preview-fullscreen-frame"
                title={`Artifact preview: ${fullscreenHtmlFile}`}
                sandbox=""
                referrerPolicy="no-referrer"
                loading="eager"
                srcDoc={htmlPreviewByFile[fullscreenHtmlFile]}
              />
            </section>
          </div>,
          document.body
        )}
      {actionError && <p className="message-artifact-error">{actionError}</p>}
    </div>
  )
}
