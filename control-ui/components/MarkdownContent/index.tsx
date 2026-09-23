'use client'

import { Fragment, useMemo } from 'react'
import type { ReactNode } from 'react'
import { parseVanillaMarkdown } from '@lib/vanillaMarkdown'
import type { MarkdownBlock, MarkdownInlineNode } from '@lib/vanillaMarkdown.types'

type MarkdownContentProps = {
  ariaLabel: string
  className: string
  emptyMessage: string
  source: string
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
  if (block.kind === 'paragraph') return <p key={block.id}>{renderInlineNodes(block.children)}</p>
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

export function MarkdownContent({
  ariaLabel,
  className,
  emptyMessage,
  source,
}: MarkdownContentProps): React.JSX.Element {
  const blocks = useMemo(() => parseVanillaMarkdown(source), [source])
  return (
    <article aria-label={ariaLabel} className={className}>
      {blocks.length > 0 ? (
        blocks.map(renderBlock)
      ) : (
        <p className="cu-gfs-markdown-preview__empty">{emptyMessage}</p>
      )}
    </article>
  )
}
