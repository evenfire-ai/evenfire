'use client'

import React from 'react'
import dynamic from 'next/dynamic'
import type { MDEditorProps } from '@uiw/react-md-editor'
import { cn } from '@lib/cn'
import type { MarkdownEditorProps } from './types'

const MDEditor = dynamic<MDEditorProps>(() => import('@uiw/react-md-editor'), {
  ssr: false,
  loading: () => <div className="cu-markdown-editor__loading">Loading markdown editor...</div>,
})

export function MarkdownEditor({
  ariaLabel,
  className,
  invalid = false,
  onChange,
  value,
}: MarkdownEditorProps) {
  return (
    <div
      className={cn('cu-markdown-editor', invalid && 'cu-markdown-editor--invalid', className)}
      data-color-mode="dark"
    >
      <MDEditor
        height="100%"
        highlightEnable={false}
        onChange={nextValue => onChange(nextValue ?? '')}
        preview="edit"
        textareaProps={{
          'aria-label': ariaLabel,
          className: invalid ? 'cu-input--invalid' : undefined,
        }}
        value={value}
        visibleDragbar={false}
      />
    </div>
  )
}
