import React from 'react'
import MDEditor from '@uiw/react-md-editor'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

type MarkdownPreviewProps = React.ComponentProps<typeof MDEditor.Markdown>
type MarkdownComponents = NonNullable<MarkdownPreviewProps['components']>

function transformMarkdownUrl(url: string, key: string): string {
  const value = url.trim()
  if (key === 'src') {
    return /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(value) ? value : ''
  }
  return /^(?:https?:\/\/|mailto:|#)/i.test(value) ? value : ''
}

const MARKDOWN_COMPONENTS: MarkdownComponents = {
  a: ({ children, href, node, ...props }) => {
    void node
    const safeHref = href ? transformMarkdownUrl(href, 'href') : ''
    return safeHref ? (
      <a {...props} href={safeHref} rel="noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    )
  },
  img: ({ alt, node, src }) => {
    void node
    const safeSrc = src ? transformMarkdownUrl(src, 'src') : ''
    return safeSrc ? (
      <img alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" src={safeSrc} />
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

const MARKDOWN_REHYPE_PLUGINS: NonNullable<MarkdownPreviewProps['rehypePlugins']> = [
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      protocols: {
        ...defaultSchema.protocols,
        src: [...(defaultSchema.protocols?.src ?? []), 'data'],
      },
    },
  ] as never,
]

const MARKDOWN_PREVIEW_OPTIONS = {
  components: MARKDOWN_COMPONENTS,
  pluginsFilter: (
    type: 'rehype' | 'remark',
    plugins: NonNullable<MarkdownPreviewProps['rehypePlugins']>
  ) =>
    type === 'rehype'
      ? plugins.filter(plugin => {
          const implementation = Array.isArray(plugin) ? plugin[0] : plugin
          return implementation !== rehypeRaw
        })
      : plugins,
  rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
  remarkPlugins: [remarkGfm],
  skipHtml: true,
  urlTransform: transformMarkdownUrl,
}

export type GfsMarkdownEditorProps = {
  ariaLabel: string
  value: string
  onChange: (value: string) => void
}

export function GfsMarkdownDocument({ source }: { source: string }) {
  return (
    <div data-color-mode="dark">
      <MDEditor.Markdown source={source} {...MARKDOWN_PREVIEW_OPTIONS} />
    </div>
  )
}

export function GfsMarkdownEditor({ ariaLabel, onChange, value }: GfsMarkdownEditorProps) {
  return (
    <div className="da-gfs-markdown-editor" data-color-mode="dark">
      <MDEditor
        height="100%"
        onChange={nextValue => onChange(nextValue ?? '')}
        previewOptions={MARKDOWN_PREVIEW_OPTIONS}
        textareaProps={{ 'aria-label': ariaLabel }}
        visibleDragbar={false}
        value={value}
      />
    </div>
  )
}
