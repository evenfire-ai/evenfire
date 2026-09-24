'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DataTable, TableViewport } from '@clerum/frontend-components'
import { IconCopy } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import { Button } from '@components/ui'
import { gfsFetchFileBlob } from '@lib/api'
import { assertGfsMarkdownPreviewSize } from '@lib/gfsMarkdownPreview'
import type { GfsMarkdownPreviewProps } from './types'

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
      <TableViewport
        aria-label="Scrollable Markdown table"
        className="gfs-markdown-table-scroll"
        embedded
        role="region"
        tabIndex={0}
      >
        <DataTable {...props} className="cu-table gfs-markdown-table" variant="embedded">
          {children}
        </DataTable>
      </TableViewport>
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

function isPlainTextName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.txt')
}

export function GfsMarkdownPreview({
  byteLength,
  fileName,
  onClose,
  rid,
}: GfsMarkdownPreviewProps): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const { showToast } = useToast()
  const isPlainText = isPlainTextName(fileName)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current)
    }
  }, [])

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

    async function loadPreview(): Promise<void> {
      try {
        assertGfsMarkdownPreviewSize(byteLength)
        const blob = await gfsFetchFileBlob(rid)
        assertGfsMarkdownPreviewSize(blob.size)
        const markdown = await blob.text()
        if (active) setSource(markdown)
      } catch (error) {
        if (!active) return
        setPreviewError(
          error instanceof Error ? error.message : 'Could not load the Markdown preview'
        )
      }
    }

    void loadPreview()
    return () => {
      active = false
    }
  }, [byteLength, rid])

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
    if (!navigator.clipboard?.writeText) {
      if (markCopyState('error')) {
        showToast('Clipboard is not available in this browser.', { tone: 'error' })
      }
      return
    }
    try {
      await navigator.clipboard.writeText(source)
      if (!mountedRef.current) return
      if (markCopyState('copied')) {
        showToast(`Copied ${fileName} to the clipboard.`, { tone: 'success' })
      }
    } catch {
      if (markCopyState('error')) {
        showToast('Copy failed — check browser clipboard permissions.', { tone: 'error' })
      }
    }
  }

  return createPortal(
    <div
      className="cu-modal-backdrop cu-gfs-markdown-preview-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="cu-gfs-markdown-preview-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="cu-gfs-markdown-preview-dialog__header">
          <h3 id={titleId}>{fileName}</h3>
          <div className="cu-gfs-markdown-preview-dialog__header-actions">
            <Button
              className="cu-gfs-markdown-preview-dialog__copy"
              variant="ghost"
              aria-label={
                copyState === 'copied'
                  ? 'Copied preview contents to clipboard'
                  : 'Copy preview contents to clipboard'
              }
              disabled={source === null}
              onClick={() => void copySourceToClipboard()}
            >
              <IconCopy width={18} height={18} />
              <span className="cu-gfs-preview-button__label">
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </span>
            </Button>
            <Button
              className="cu-gfs-markdown-preview-dialog__close"
              data-preview-close
              variant="ghost"
              aria-label="Close preview"
              onClick={onClose}
            >
              <IconX width={18} height={18} />
            </Button>
          </div>
        </header>
        <div className="cu-gfs-markdown-preview-dialog__body">
          {previewError ? (
            <div className="cu-banner cu-banner--error" role="alert">
              {previewError}
            </div>
          ) : null}
          {!previewError && source === null ? (
            <div className="cu-gfs-markdown-preview-dialog__loading" role="status">
              Loading preview…
            </div>
          ) : null}
          {source !== null && !previewError ? (
            isPlainText ? (
              <article
                aria-label={`Text preview of ${fileName}`}
                className="cu-gfs-text-preview__content"
              >
                {source.length > 0 ? (
                  <pre className="cu-gfs-text-preview__body">{source}</pre>
                ) : (
                  <p className="cu-gfs-markdown-preview__empty">This text file is empty.</p>
                )}
              </article>
            ) : (
              <article
                aria-label={`Markdown preview of ${fileName}`}
                className="cu-gfs-markdown-preview__content"
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
                  <p className="cu-gfs-markdown-preview__empty">This Markdown file is empty.</p>
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
