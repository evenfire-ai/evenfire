import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, StatusBanner } from '@components/Common'
import { IconClose, IconCopy } from '@components/SidebarNav/icons'
import { assertGfsMarkdownPreviewSize } from '@lib/gfsMarkdownPreview'
import { parseVanillaMarkdown } from '@lib/vanillaMarkdown'
import type { MarkdownBlock, MarkdownInlineNode } from '@lib/vanillaMarkdown.types'
import type { GfsMarkdownPreviewProps } from './types'

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

export function GfsMarkdownPreview({
  byteLength,
  fileName,
  gfsUri,
  onClose,
  onDownloadError,
}: GfsMarkdownPreviewProps) {
  const titleId = useId()
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blocks = useMemo(() => (source === null ? [] : parseVanillaMarkdown(source)), [source])
  const isPlainText = isPlainTextName(fileName)

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    }
  }, [])

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

    const loadPreview = async () => {
      try {
        assertGfsMarkdownPreviewSize(byteLength)
        const { bytes } = await window.clerum.gfs.download(gfsUri)
        assertGfsMarkdownPreviewSize(bytes.byteLength)
        const markdown = new TextDecoder().decode(bytes)
        if (active) setSource(markdown)
      } catch (error) {
        if (!active) return
        onDownloadError?.(error)
        setPreviewError(
          error instanceof Error ? error.message : 'Could not load the Markdown preview'
        )
      }
    }

    void loadPreview()
    return () => {
      active = false
    }
  }, [byteLength, gfsUri, onDownloadError])

  async function copySourceToClipboard(): Promise<void> {
    if (source === null) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(source)
        setCopyState('copied')
      } else {
        setCopyState('error')
      }
    } catch {
      setCopyState('error')
    }
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    copyResetTimeoutRef.current = setTimeout(() => setCopyState('idle'), 2000)
  }

  return createPortal(
    <div
      className="da-gfs-markdown-preview-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="da-gfs-markdown-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="da-gfs-markdown-preview-dialog__header">
          <h3 id={titleId}>{fileName}</h3>
          <div className="da-gfs-markdown-preview-dialog__header-actions">
            <IconButton
              label={
                copyState === 'copied'
                  ? 'Copied preview contents to clipboard'
                  : 'Copy preview contents to clipboard'
              }
              disabled={source === null}
              onClick={() => void copySourceToClipboard()}
              size="sm"
              variant="ghost"
            >
              <IconCopy />
            </IconButton>
            <IconButton
              ref={closeButtonRef}
              label="Close preview"
              onClick={onClose}
              size="sm"
              variant="ghost"
            >
              <IconClose />
            </IconButton>
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
      </section>
    </div>,
    document.body
  )
}

export type { GfsMarkdownPreviewProps } from './types'
