'use client'

import React from 'react'
import dynamic from 'next/dynamic'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from '@lib/cn'
import { safeMarkdownHref } from '@lib/vanillaMarkdown'

type MarkdownPreviewProps = React.ComponentProps<
  typeof import('@uiw/react-md-editor').default.Markdown
>

type MarkdownContentProps = {
  ariaLabel: string
  className: string
  emptyMessage: string
  source: string
}

const MarkdownPreview = dynamic<MarkdownPreviewProps>(
  () => import('@uiw/react-md-editor').then(editor => editor.default.Markdown),
  {
    ssr: false,
    loading: () => (
      <div className="cu-identity-preview__loading" role="status">
        Loading Markdown preview...
      </div>
    ),
  }
)

function renderMarkdownLink({ children, href }: { children?: React.ReactNode; href?: string }) {
  const safeHref = safeMarkdownHref(href ?? '')
  if (!safeHref) return <span>{children}</span>
  const isFragment = safeHref.startsWith('#')
  const fragment = safeHref.slice(1)
  const alignedHref = isFragment
    ? `#${fragment.startsWith('user-content-') ? fragment : `user-content-${fragment}`}`
    : safeHref
  return (
    <a
      href={alignedHref}
      rel={isFragment ? undefined : 'noreferrer'}
      target={isFragment ? undefined : '_blank'}
    >
      {children}
    </a>
  )
}

function renderMarkdownImage({ alt }: { alt?: string | null }) {
  return <span>[Image: {alt ?? ''}]</span>
}

export function MarkdownContent({
  ariaLabel,
  className,
  emptyMessage,
  source,
}: MarkdownContentProps): React.JSX.Element {
  if (!source.trim()) {
    return (
      <article aria-label={ariaLabel} className="cu-identity-preview__document">
        <div className={cn('cu-gfs-markdown-preview__content', className)}>
          <p className="cu-gfs-markdown-preview__empty">{emptyMessage}</p>
        </div>
      </article>
    )
  }

  const components: MarkdownPreviewProps['components'] = {
    a: renderMarkdownLink,
    img: renderMarkdownImage,
  }

  return (
    <article
      aria-label={ariaLabel}
      className="cu-identity-preview__document"
      data-color-mode="dark"
    >
      <MarkdownPreview
        className={cn('cu-gfs-markdown-preview__content', className)}
        components={components}
        disableCopy
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        source={source}
        urlTransform={url => safeMarkdownHref(url) ?? ''}
      />
    </article>
  )
}
