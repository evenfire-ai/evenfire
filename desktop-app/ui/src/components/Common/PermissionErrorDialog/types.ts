import type { Query } from '@tanstack/react-query'

export type PermissionRetryAttempt = {
  admitted: boolean
  completion?: Promise<unknown>
}

export type PermissionRetryContext = {
  onAdmitted: () => boolean | void
  isOriginCurrent: () => boolean
}

export type PermissionRetryFailureDisposition = 'presented' | 'stale'

export type PermissionErrorItem = {
  id: string
  message: string
  retry?: (context?: PermissionRetryContext) => PermissionRetryAttempt
  queryIdentity?: Query
  errorUpdateCount?: number
  token?: symbol
  pending?: boolean
  onRetryFailure?: (
    error: unknown,
    context: Pick<PermissionRetryContext, 'isOriginCurrent'>
  ) => PermissionRetryFailureDisposition
}

export type PermissionErrorDialogProps = {
  errors: PermissionErrorItem[]
  onDismiss: (ids: string[]) => void
  title?: string
  suspended?: boolean
  progress?: string[]
}
