// Renderer exception recorded in docs/agents/frontend-style-rules.md
// ("Markdown rendering and editing"): this read-only GFS markdown preview uses
// ReactMarkdown + remark-gfm as the established, tested preview integration.
// GFM tables use a labelled, keyboard-focusable scroll region.
// MDEditor.Markdown supports custom table components; switching requires a
// separate migration that revalidates rendering, keyboard operation, and
// untrusted-content handling. Guarantees: no rehype-raw, so raw HTML stays
// inert; urlTransform restricts `src` to inline data:image URIs and links to
// http(s):/mailto:/# fragments; code blocks render as plain `pre` > `code`.
// Covered by the GfsMarkdownPreview and GfsMarkdownPreviewBody suites.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { StatusBanner } from '@components/Common'
import { GFS_MARKDOWN_PREVIEW_MAX_BYTES } from '@constants/gfsMarkdownPreview'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { assertGfsMarkdownPreviewSize } from '@lib/gfsMarkdownPreview'
import type { GfsMarkdownPreviewBodyProps } from './types'

function isPlainTextName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.txt')
}

function transformMarkdownUrl(url: string, key: string): string {
  const value = url.trim()
  if (key === 'src') {
    return /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(value) ? value : ''
  }
  return /^(?:https?:\/\/|mailto:|#)/i.test(value) ? value : ''
}

const GFS_MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href, node, ...props }) => {
    void node
    return href ? (
      <a {...props} href={href} rel="noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    )
  },
  img: ({ alt, node, src, ...props }) => {
    void node
    return src ? (
      <img {...props} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" src={src} />
    ) : alt ? (
      <span>{alt}</span>
    ) : null
  },
  table: ({ children, node, ...props }) => {
    void node
    return (
      <div
        aria-label="Scrollable Markdown table"
        className="gfs-markdown-table-scroll"
        role="region"
        tabIndex={0}
      >
        <table {...props}>{children}</table>
      </div>
    )
  },
  th: ({ children, node, ...props }) => {
    void node
    return (
      <th {...props} scope={props.scope ?? 'col'}>
        {children}
      </th>
    )
  },
}

const GFS_MARKDOWN_REMARK_PLUGINS = [remarkGfm]

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
  onDownloadError,
  recordOpen,
  onCopyContentReady,
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
        const { bytes } = await window.clerum.gfs.downloadPreview(
          gfsUri,
          GFS_MARKDOWN_PREVIEW_MAX_BYTES,
          recordOpen
        )
        assertGfsMarkdownPreviewSize(bytes.byteLength)
        const markdown = new TextDecoder().decode(bytes)
        if (active) setSource(markdown)
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
  }, [byteLength, gfsUri])

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
        {source !== null && !previewError ? (
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
                <ReactMarkdown
                  components={GFS_MARKDOWN_COMPONENTS}
                  remarkPlugins={GFS_MARKDOWN_REMARK_PLUGINS}
                  urlTransform={transformMarkdownUrl}
                >
                  {source}
                </ReactMarkdown>
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
