export interface NewFolderModalProps {
  /** Display label of the parent folder (e.g. "main" or "Drive root"). */
  folderLabel: string
  /** True while the create request is in flight — disables inputs and Cancel. */
  pending: boolean
  /** Server error to surface, or null when there is none. */
  error: string | null
  /** Called with the trimmed raw name when the operator confirms. */
  onCreate: (name: string) => void
  /** Called on Escape / backdrop / Cancel. Gated by `pending` inside the modal. */
  onCancel: () => void
}
