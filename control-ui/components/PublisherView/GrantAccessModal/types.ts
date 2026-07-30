export interface GrantAccessModalProps {
  /** Display name as it appears in the owner table (e.g. "db" or already "@scope/db"). */
  entryName: string
  /** Owning org slug (used to normalize {@link entryName} into `@scope/name`). */
  orgScope: string
  /** Called when the operator dismisses the modal (Escape / backdrop / Close). */
  onClose: () => void
}
