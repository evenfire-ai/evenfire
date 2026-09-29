export type GfsInheritedAccessRole = 'read' | 'editor'

export type GfsInheritedAccessDialogFolder = {
  name: string
  /** Role the member holds on that ancestor folder today. */
  currentRole: GfsInheritedAccessRole
}

export type GfsInheritedAccessDialogRequest = {
  /** 'change-role' confirms a parent-folder role update; 'remove' removes the member from every contributing ancestor folder. */
  mode: 'change-role' | 'remove'
  memberLabel: string
  /** The file whose Share dialog opened this confirmation. */
  fileName: string
  /**
   * Every ancestor folder the confirm will touch (R1-H1): all contributing
   * folders for a removal, the folders above the target role for a
   * downgrade, the single raised folder for an upgrade.
   */
  folders: GfsInheritedAccessDialogFolder[]
  /** Role the member effectively holds on this file today. */
  fileCurrentRole: GfsInheritedAccessRole
  /** change-role: the role that will replace the folders'/file's current role. */
  nextRole?: GfsInheritedAccessRole
}

export interface GfsInheritedAccessDialogProps {
  request: GfsInheritedAccessDialogRequest | null
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}
