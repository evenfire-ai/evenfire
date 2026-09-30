import type { ToastMessage } from '@/uiTypes'

export type ToastStackProps = {
  items: ToastMessage[]
  /** Removes a toast before its auto-dismiss (e.g. after its action ran). */
  onDismiss?: (id: number) => void
}
