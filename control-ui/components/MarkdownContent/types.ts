/**
 * `standard`: the operator's own documents (`http(s):`, `mailto:` and in-page
 * fragments are links). `https-only`: Markdown authored outside this deployment,
 * where only absolute `https://` links stay links and they always open in a new tab.
 */
export type MarkdownLinkPolicy = 'standard' | 'https-only'

export type MarkdownContentProps = {
  ariaLabel: string
  className: string
  emptyMessage: string
  source: string
  linkPolicy?: MarkdownLinkPolicy
}
