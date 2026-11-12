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
  /**
   * Folders whose SHARING entries still grant Editor after this change. The
   * change rewrites the folders' GRANT rows and revokes their conflicting
   * sharing entries (RP-032), so what survives is the share-only ancestor
   * this panel cannot rewrite. The confirmation says so BEFORE the user
   * approves — the effective role it shows is not the whole truth, and only
   * the post-change toast used to say so.
   */
  residualEditorFolderNames?: string[]
}

export interface GfsInheritedAccessDialogProps {
  request: GfsInheritedAccessDialogRequest | null
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}
