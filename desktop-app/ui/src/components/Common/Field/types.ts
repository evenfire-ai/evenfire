import type { ReactNode } from 'react'

export type FieldProps = {
  children: ReactNode
  hint?: ReactNode
  label?: ReactNode
  /**
   * Wire the rendered <label> to a specific input `id`. Setting this makes
   * the field screen-reader-associated AND exposes the label to testing
   * libraries via `page.getByLabel(...)`, which is the preferred
   * production-code-clean selector for Playwright / Testing Library.
   */
  htmlFor?: string
  labelClassName?: string
  wrapperClassName?: string
}
