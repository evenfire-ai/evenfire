import type { ReactNode } from 'react'

export type PageBreadcrumbItem = {
  label: ReactNode
  onClick?: () => void
}

export type PageBreadcrumbProps = {
  ariaLabel: string
  items: PageBreadcrumbItem[]
}
