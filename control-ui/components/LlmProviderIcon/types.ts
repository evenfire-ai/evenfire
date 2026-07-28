import type { LlmProvider } from '@/lib/llm'

export type LlmProviderIconProps = {
  provider: LlmProvider
  // Rendered as the single-letter fallback when the provider SVG fails to load.
  label: string
}
