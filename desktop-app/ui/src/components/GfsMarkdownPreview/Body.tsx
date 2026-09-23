import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, StatusBanner } from '@components/Common'
import { IconCopy } from '@components/SidebarNav/icons'
import { GFS_MARKDOWN_PREVIEW_MAX_BYTES } from '@constants/gfsMarkdownPreview'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { assertGfsMarkdownPreviewSize } from '@lib/gfsMarkdownPreview'
import { parseVanillaMarkdown } from '@lib/vanillaMarkdown'
import type { MarkdownBlock, MarkdownInlineNode } from '@lib/vanillaMarkdown.types'
import type { GfsMarkdownPreviewBodyProps } from './types'

function isPlainTextName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.txt')
}

function renderInlineNodes(nodes: MarkdownInlineNode[]): ReactNode[] {
  return nodes.map(node => {
    if (node.kind === 'text') return <Fragment key={node.id}>{node.value}</Fragment>
    if (node.kind === 'code') return <code key={node.id}>{node.value}</code>
    const children = renderInlineNodes(node.children)
    if (node.kind === 'strong') return <strong key={node.id}>{children}</strong>
    if (node.kind === 'emphasis') return <em key={node.id}>{children}</em>
    if (node.kind === 'strikethrough') return <s key={node.id}>{children}</s>
    return node.href ? (
      <a href={node.href} key={node.id} rel="noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <span key={node.id}>{children}</span>
    )
  })
}

function renderHeading(block: Extract<MarkdownBlock, { kind: 'heading' }>): ReactNode {
  const children = renderInlineNodes(block.children)
  if (block.level === 1) return <h1 key={block.id}>{children}</h1>
  if (block.level === 2) return <h2 key={block.id}>{children}</h2>
  if (block.level === 3) return <h3 key={block.id}>{children}</h3>
  if (block.level === 4) return <h4 key={block.id}>{children}</h4>
  if (block.level === 5) return <h5 key={block.id}>{children}</h5>
  return <h6 key={block.id}>{children}</h6>
}

function renderBlock(block: MarkdownBlock): ReactNode {
  if (block.kind === 'heading') return renderHeading(block)
  if (block.kind === 'paragraph') {
    return <p key={block.id}>{renderInlineNodes(block.children)}</p>
  }
  if (block.kind === 'blockquote') {
    return <blockquote key={block.id}>{renderInlineNodes(block.children)}</blockquote>
  }
  if (block.kind === 'divider') return <hr key={block.id} />
  if (block.kind === 'code') {
    return (
      <pre key={block.id}>
        <code data-language={block.language ?? undefined}>{block.value}</code>
      </pre>
    )
  }
  const items = block.items.map(item => <li key={item.id}>{renderInlineNodes(item.children)}</li>)
  return block.ordered ? <ol key={block.id}>{items}</ol> : <ul key={block.id}>{items}</ul>
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
  const blocks = useMemo(() => (source === null ? [] : parseVanillaMarkdown(source)), [source])
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
              {blocks.length > 0 ? (
                blocks.map(renderBlock)
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
