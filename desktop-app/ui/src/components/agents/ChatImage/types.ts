import type { ReactNode } from 'react'

export type ChatImageProps = {
  src: string
  alt: string
  className: string
  fallback: ReactNode
  onShow?: () => void
  onLoad?: () => void
}
