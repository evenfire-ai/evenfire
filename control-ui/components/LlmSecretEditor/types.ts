export type LlmSecretEditorProps = {
  secretName: string
  existingKeys: string[]
  /** Credential slots still referenced by persisted Host fallback policies. */
  protectedCredentialSlots?: string[]
  /**
   * Called when the operator cancels or a save completes successfully. The
   * owning surface (route page) owns navigation; the editor owns the write.
   */
  onClose: () => void
}
