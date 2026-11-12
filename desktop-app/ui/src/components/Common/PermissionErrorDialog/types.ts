import type { Query } from '@tanstack/react-query'

export type PermissionRetryAttempt = {
  admitted: boolean
  completion?: Promise<unknown>
}

export type PermissionErrorItem = {
  id: string
  message: string
  retry?: () => PermissionRetryAttempt
  queryIdentity?: Query
  errorUpdateCount?: number
}

export type PermissionErrorDialogProps = {
  errors: PermissionErrorItem[]
  onDismiss: (ids: string[]) => void
  title?: string
  suspended?: boolean
  progress?: string[]
}
