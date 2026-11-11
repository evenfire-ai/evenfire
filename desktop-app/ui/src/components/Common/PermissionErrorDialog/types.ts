export type PermissionErrorItem = {
  id: string
  message: string
  retry?: () => void | Promise<unknown>
  queryIdentity?: object
  errorUpdateCount?: number
}

export type PermissionErrorDialogProps = {
  errors: PermissionErrorItem[]
  onDismiss: (ids: string[]) => void
  title?: string
  suspended?: boolean
  progress?: string[]
}
