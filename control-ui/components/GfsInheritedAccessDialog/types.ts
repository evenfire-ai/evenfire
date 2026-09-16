export type GfsInheritedAccessRole = 'read' | 'editor'

export type GfsInheritedAccessDialogRequest = {
  /** 'change-role' confirms a parent-folder role update; 'remove' removes the member from the parent folder. */
  mode: 'change-role' | 'remove'
  memberLabel: string
  parentFolderName: string
  /** The file whose Share dialog opened this confirmation. */
  fileName: string
  /** Role the member holds on the parent folder today. */
  parentCurrentRole: GfsInheritedAccessRole
  /** Role the member effectively holds on this file today. */
  fileCurrentRole: GfsInheritedAccessRole
  /** change-role: the role that will replace parentCurrentRole/fileCurrentRole. */
  nextRole?: GfsInheritedAccessRole
  /** remove: the direct access that survives on the file, null for none. */
  fileRemainingRole?: GfsInheritedAccessRole | null
}

export interface GfsInheritedAccessDialogProps {
  request: GfsInheritedAccessDialogRequest | null
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}
