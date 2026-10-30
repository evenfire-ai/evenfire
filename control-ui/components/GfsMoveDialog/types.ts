export type MoveFolder = {
  resourceId: string
  name: string
  kind: string
  /** Present on browser rows so a no-op move to the current parent is refused. */
  parentResourceId?: string | null
}

export type MoveCrumb = {
  id: string | null
  name: string
}

export type MoveTreePage = {
  rootResourceId?: string
  items: MoveFolder[]
  nextCursor: string | null
}

export type SelectedMoveDestination = Pick<MoveFolder, 'resourceId' | 'name'>

/**
 * The destination the operator approved, together with the names the dialog
 * already knows INSIDE it.
 *
 * The browser's own children cache is cold for a destination that only this
 * dialog discovered (a nested folder the current listing never showed), so
 * without this seed the numbered-name ladder starts blind: it burns its
 * three attempts on names the destination already holds and reports "The
 * destination changed" instead of landing on the first free numbered name
 * (RP-003).
 */
export type MoveDestinationRequest = {
  resourceId: string
  name: string
  /** Names the destination already holds, as observed by this dialog. */
  occupiedNames: string[]
}

export type GfsMoveDialogProps = {
  target: MoveFolder
  initialCrumbs: MoveCrumb[]
  busy?: boolean
  onClose: () => void
  onMove: (destination: MoveDestinationRequest) => Promise<void>
}

export type MoveTreeFolderProps = {
  ancestors: ReadonlySet<string>
  expandedIds: ReadonlySet<string>
  folder: MoveFolder
  level: number
  selected: SelectedMoveDestination | null
  targetId: string
  /** Reports the names loaded inside a folder so the dialog can seed the
   *  numbered-name ladder with them (RP-003). */
  onChildrenLoaded: (folderId: string, names: string[]) => void
  onSelect: (folder: MoveFolder) => void
  onToggle: (folderId: string) => void
}
