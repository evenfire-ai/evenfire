import type { ComposerGlobalFileReference } from '@/uiTypes'

export type ComposerGlobalFilesModalProps = {
  onAdd: (attachments: ComposerGlobalFileReference[]) => void
  onClose: () => void
}

export type ComposerGlobalFileSelection = Record<string, ComposerGlobalFileReference>
