import type { ReactNode } from 'react'

export type PageBreadcrumbItem = {
  label: ReactNode
  onClick?: () => void
  className?: string
}

export type PageBreadcrumbProps = {
  ariaLabel: string
  items: PageBreadcrumbItem[]
}
