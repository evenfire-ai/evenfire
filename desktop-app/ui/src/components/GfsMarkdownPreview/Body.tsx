import { useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button, StatusBanner } from '@components/Common'
import { IconCopy } from '@components/SidebarNav/icons'
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
    return /^(?:https:\/\/|data:image\/(?:png|gif|jpe?g|webp);base64,)/i.test(value) ? value : ''
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
  titleId,
  headerActions,
  headingLevel = 3,
}: GfsMarkdownPreviewBodyProps) {
  const generatedTitleId = useId()
  const headingId = titleId ?? generatedTitleId
  const [source, setSource] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
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
          GFS_MARKDOWN_PREVIEW_MAX_BYTES
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

  function markCopyState(state: 'copied' | 'error'): boolean {
    if (!mountedRef.current) return false
    setCopyState(state)
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    copyResetTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyState('idle')
    }, 2000)
    return true
  }

  async function copySourceToClipboard(): Promise<void> {
    if (source === null || !mountedRef.current) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(source)
        if (!mountedRef.current) return
        markCopyState('copied')
      } else {
        markCopyState('error')
      }
    } catch {
      markCopyState('error')
    }
  }

  return (
    <>
      <header className="da-gfs-markdown-preview-dialog__header">
        <HeadingTag className="da-gfs-preview-title" id={headingId}>
          {fileName}
        </HeadingTag>
        <div className="da-gfs-markdown-preview-dialog__header-actions">
          <Button
            className="da-gfs-markdown-preview-dialog__copy"
            aria-label={
              copyState === 'copied'
                ? 'Copied preview contents to clipboard'
                : 'Copy preview contents to clipboard'
            }
            color="neutral"
            disabled={source === null}
            onClick={() => void copySourceToClipboard()}
            variant="ghost"
          >
            <IconCopy width={18} height={18} />
            <span className="da-gfs-preview-button__label">
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </span>
          </Button>
          {headerActions}
        </div>
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
