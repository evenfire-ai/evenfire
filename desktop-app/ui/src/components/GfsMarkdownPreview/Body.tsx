import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { StatusBanner } from '@components/Common'
import { GFS_MARKDOWN_PREVIEW_MAX_BYTES } from '@constants/gfsMarkdownPreview'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { assertGfsMarkdownPreviewSize } from '@lib/gfsMarkdownPreview'
import { GfsMarkdownDocument } from './MarkdownAdapter'
import type { GfsMarkdownPreviewBodyProps } from './types'

function isPlainTextName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.txt')
}

/**
 * De-modalized markdown/text preview body (spec 18 §3.B.2). Owns the byte fetch
 * (by `gfsUri`), the size-guard, copy-source-to-clipboard, and the rendered
 * markdown/plain-text `<article>` + loading/error states. Renders no modal
 * chrome. Fails closed: a download error both shows the reason and is routed to
 * `onDownloadError`.
 */
export function GfsMarkdownPreviewBody({
  byteLength,
  fileName,
  gfsUri,
  expectedSessionGeneration,
  onDownloadError,
  onCopyContentReady,
  onSourceLoaded,
  editor,
  titleId,
  titleActions,
  headerActions,
  headingLevel = 3,
}: GfsMarkdownPreviewBodyProps) {
  const generatedTitleId = useId()
  const headingId = titleId ?? generatedTitleId
  const [source, setSource] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const onDownloadErrorRef = useRef(onDownloadError)
  const isPlainText = isPlainTextName(fileName)
  const HeadingTag = `h${headingLevel}` as const

  useEffect(() => {
    onDownloadErrorRef.current = onDownloadError
  }, [onDownloadError])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true

    const loadPreview = async () => {
      try {
        // The listed size is a skip HINT (fail fast without a round-trip); the
        // download itself is independently bounded so a wrong listed size cannot
        // materialize an oversized payload.
        assertGfsMarkdownPreviewSize(byteLength)
        let stable: { content: string; version: number } | null = null
        for (let attempt = 0; attempt < 2 && !stable; attempt += 1) {
          const before = await window.clerum.gfs.resolve(gfsUri, expectedSessionGeneration)
          const { bytes } = await window.clerum.gfs.downloadPreview(
            gfsUri,
            GFS_MARKDOWN_PREVIEW_MAX_BYTES,
            expectedSessionGeneration
          )
          assertGfsMarkdownPreviewSize(bytes.byteLength)
          const after = await window.clerum.gfs.resolve(gfsUri, expectedSessionGeneration)
          if (before.version === after.version) {
            stable = { content: new TextDecoder().decode(bytes), version: after.version }
          }
        }
        if (!stable) throw new Error('The file changed while loading. Refresh to try again.')
        if (active) {
          setSource(stable.content)
          onSourceLoaded?.(stable.content, stable.version)
        }
      } catch (error) {
        if (!active) return
        onDownloadErrorRef.current?.(error)
        // Through the shared read-plane presenter, not raw — see the note in
        // `GfsImagePreview/Body.tsx`. A 429 crossing Electron IPC otherwise
        // reaches the banner as "Error invoking remote method
        // 'gfs:downloadPreview': Error: 429 …"; every other verdict, including
        // the size guard and the download ceiling, passes through untouched.
        setPreviewError(
          error instanceof Error
            ? describeGfsReadError(error).message
            : 'Could not load the Markdown preview'
        )
      }
    }

    void loadPreview()
    return () => {
      active = false
    }
  }, [byteLength, expectedSessionGeneration, gfsUri, onSourceLoaded])

  const copySourceToClipboard = useCallback(async (): Promise<boolean> => {
    if (source === null || !mountedRef.current || previewError) return false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(source)
        return mountedRef.current
      } else {
        return false
      }
    } catch {
      return false
    }
  }, [previewError, source])

  useEffect(() => {
    onCopyContentReady?.(source !== null && !previewError ? copySourceToClipboard : null)
    return () => onCopyContentReady?.(null)
  }, [copySourceToClipboard, onCopyContentReady, previewError, source])

  return (
    <>
      <header className="da-gfs-markdown-preview-dialog__header">
        <div className="da-gfs-preview-title-row">
          <HeadingTag className="da-gfs-preview-title" id={headingId}>
            {fileName}
          </HeadingTag>
          {titleActions}
        </div>
        <div className="da-gfs-markdown-preview-dialog__header-actions">{headerActions}</div>
      </header>
      <div className="da-gfs-markdown-preview-dialog__body">
        {previewError ? <StatusBanner tone="error" text={previewError} /> : null}
        {!previewError && source === null ? (
          <div className="da-gfs-markdown-preview-dialog__loading" role="status">
            Loading preview…
          </div>
        ) : null}
        {editor && source !== null && !previewError ? editor : null}
        {source !== null && !previewError && !editor ? (
          isPlainText ? (
            <article
              aria-label={`Text preview of ${fileName}`}
              className="da-gfs-text-preview__content"
            >
              {source.length > 0 ? (
                <pre className="da-gfs-text-preview__body">{source}</pre>
              ) : (
                <p className="da-gfs-markdown-preview__empty">This text file is empty.</p>
              )}
            </article>
          ) : (
            <article
              aria-label={`Markdown preview of ${fileName}`}
              className="da-gfs-markdown-preview__content markdown-content"
            >
              {source.trim() ? (
                <GfsMarkdownDocument source={source} />
              ) : (
                <p className="da-gfs-markdown-preview__empty">This Markdown file is empty.</p>
              )}
            </article>
          )
        ) : null}
      </div>
    </>
  )
}
