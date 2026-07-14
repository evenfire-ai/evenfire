import type { ReactNode } from 'react'
import type { Tone } from '@/uiTypes'

export type StatusBannerProps = {
  /** Banner text. Optional when `children` is provided. */
  text?: string
  /** Rich content alternative to `text`. */
  children?: ReactNode
  tone: Tone
  leadingIcon?: string
  /** Tighter padding/font for inline header use (D.5). */
  compact?: boolean
}
