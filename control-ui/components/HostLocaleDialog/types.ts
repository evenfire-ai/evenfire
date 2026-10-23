/** A Host's spec.locale as the form edits it; an empty string leaves that value unset. */
export type HostLocaleValue = {
  language: string
  timeZone: string
}

export type HostLocaleDialogProps = {
  open: boolean
  locale: HostLocaleValue
  pending: boolean
  error?: string
  onCancel: () => void
  onSave: (locale: HostLocaleValue) => void
}
