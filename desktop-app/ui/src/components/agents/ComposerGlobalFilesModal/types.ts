import type { ComposerGlobalFileReference } from '@/uiTypes'

export type ComposerGlobalFilesModalProps = {
  /** Ids of the global files already in the composer; they count against the per-message limit. */
  attachedIds: readonly string[]
  onAdd: (attachments: ComposerGlobalFileReference[]) => void
  onClose: () => void
}

export type ComposerGlobalFileSelection = Record<string, ComposerGlobalFileReference>
