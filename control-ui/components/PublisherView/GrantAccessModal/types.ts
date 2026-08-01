export interface GrantAccessModalProps {
  /** Display name as it appears in the owner table (e.g. "db" or already "@scope/db"). */
  entryName: string
  /** Owning org slug (used to normalize {@link entryName} into `@scope/name`). */
  orgScope: string
  /** The control that opened the dialog, restored when the dialog closes. */
  opener?: HTMLElement | null
  /** Called when the operator dismisses the modal (Escape / backdrop / Close). */
  onClose: () => void
}
