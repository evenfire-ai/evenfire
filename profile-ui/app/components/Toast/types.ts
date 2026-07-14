export type ToastTone = 'info' | 'success' | 'error'

export type ToastOptions = {
  durationMs?: number
  tone?: ToastTone
}

export type ToastRecord = {
  id: string
  message: string
  tone: ToastTone
}

export type ToastContextValue = {
  dismissToast: (id: string) => void
  showToast: (message: string, options?: ToastOptions) => void
}
