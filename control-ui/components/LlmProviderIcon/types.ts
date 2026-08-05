export type LlmProviderIconProps = {
  // Catalog rows may contain an operator-defined provider that is not yet in
  // the canonical registry. The icon component already falls back to the
  // label's initial when no matching asset exists.
  provider: string
  // Rendered as the single-letter fallback when the provider SVG fails to load.
  label: string
}
